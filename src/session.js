// The meeting: audio in -> Voicegain -> transcript, plus your notes and speaker choices; on stop it writes the
// three output files (transcript.md, personal-notes.md, summary.md) and recovery data under .data/.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { stereoLevels } from './audio/wav.js';
import { parseNoteLine } from './notes.js';
import { renderPersonalNotes, renderTranscript } from './render.js';
import { MeetingFolder } from './storage.js';
import { SpeakerBook } from './speakers.js';
import { fallbackSummary, summarize as realSummarize } from './summarize/index.js';
import { loadTemplate } from './summarize/template.js';
import { redact } from './config.js';
import { VoicegainLink, startSession as realStartSession } from './voicegain/client.js';
import { TranscriptBuilder } from './voicegain/transcript.js';

export const BYTES_PER_SEC = 64000; // 16 kHz * 2 channels * 2 bytes
const MAX_QUEUE = 1800;             // 3 minutes of frames buffered while Voicegain is unreachable
const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 15000];

export class MeetingSession extends EventEmitter {
  constructor(cfg, deps = {}) {
    super();
    this.cfg = cfg;
    this.deps = {
      sourceFactory: deps.sourceFactory,
      startSession: deps.startSession || realStartSession,
      linkFactory: deps.linkFactory || ((s) => new VoicegainLink(s)),
      summarizer: deps.summarizer || realSummarize,
      fetchImpl: deps.fetchImpl || fetch,
      now: deps.now || (() => new Date()),
    };
    this.state = 'ready';                // ready | recording | paused | stopping | done
    this.title = ''; this.templateName = cfg.template;
    this.book = new SpeakerBook({ me: cfg.me });
    this.notes = []; this.hints = [];
    this.builder = new TranscriptBuilder({ lineGapMs: cfg.voicegain.lineGapMs });
    this.bytes = 0; this.queue = [];
    this.link = null; this.linkState = 'idle'; this.linkCount = 0; this.retries = 0;
    this._pendingOffset = 0; this._opening = false; this._timer = null;
    this.levels = { mic: 0, sys: 0 }; this._lastLevel = 0;
    this.logs = []; this.folder = null; this.startedAt = null; this.source = null; this.result = null;
    this.sourceEnded = false;
  }

  // ---------- small helpers ----------
  log(level, text) { const e = { level, text: redact(text, this.cfg), at: Date.now() }; this.logs.push(e); if (this.logs.length > 200) this.logs.shift(); this.emit('log', e); }
  clockSec() { return this.bytes / BYTES_PER_SEC; }
  _setState(s) { this.state = s; this.emit('state', s); }
  _setLink(s) { this.linkState = s; this.emit('link', s); }
  _event(obj) { try { this.folder?.appendJsonl('events.jsonl', { ...obj, at: this.clockSec() }); } catch { /* disk full etc: never crash the meeting */ } }
  _save(name, obj) { try { this.folder?.appendJsonl(name, obj); } catch { /* ignore */ } }

  // ---------- lifecycle ----------
  async start() {
    if (this.state !== 'ready') return false;
    this.startedAt = this.deps.now();
    this.folder = new MeetingFolder(this.cfg.outputDir, this.startedAt);
    this._writeMeta();
    this.notes.forEach((n) => this._save('notes.jsonl', n));
    this._event({ type: 'me', name: this.book.me }); this._event({ type: 'roster', roster: this.book.roster }); this._event({ type: 'mode', mode: this.book.mode });
    const src = this.deps.sourceFactory(this);
    this.source = src;
    src.on('data', (f) => this._onFrame(f));
    src.on('warn', (m) => this.log('warn', `audio: ${m}`));
    src.on('info', (m) => this.log('info', `audio: ${m}`));
    src.on('fault', (m) => this.log('error', `audio: ${m}`));
    src.on('error', (e) => this.log('error', `audio: ${e.message}`));
    src.on('end', () => { this.sourceEnded = true; this.emit('source-end'); });
    try { await src.start(); } catch (e) {
      try { fs.rmSync(this.folder.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.folder = null; this.source = null;
      throw e;
    }
    this._setState('recording');
    this._pendingOffset = 0;
    this._openLink();
    return true;
  }

  pause() {
    if (this.state !== 'recording') return false;
    this._setState('paused'); this._event({ type: 'pause' });
    this.log('info', 'Paused: no audio is captured or sent while paused.');
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this._setState('recording'); this._event({ type: 'resume' });
    if (!this.link && !this._opening) { this._pendingOffset = this.bytes; this._openLink(); }
    return true;
  }

  /** Manual reconnect after the automatic retries gave up. */
  reconnect() {
    if (this._opening || this.link) return false;
    clearTimeout(this._timer); this.retries = 0; this._openLink(); return true;
  }

  async stop({ summarize = true } = {}) {
    if (this.state !== 'recording' && this.state !== 'paused') return null;
    this._setState('stopping');
    clearTimeout(this._timer);
    this.emit('progress', 'Finishing transcription...');
    try { await this.source?.stop(); } catch { /* ignore */ }
    for (let i = 0; i < 40 && this._opening; i++) await new Promise((r) => setTimeout(r, 100));
    if (!this.link && this.queue.length && this.linkState !== 'failed') { clearTimeout(this._timer); this.emit('progress', 'Reconnecting to send the last audio...'); await this._openLink(); }
    if (this.link) {
      for (let i = 0; i < 30 && this.queue.length && this.link.healthy; i++) { this._flushQueue(); await new Promise((r) => setTimeout(r, 100)); }
      await this.link.end(8000);
      this.link = null;
    }
    this._setLink('idle');
    return this._finalize(summarize);
  }

  // ---------- audio ----------
  _onFrame(buf) {
    const now = Date.now();
    if (now - this._lastLevel > 120) { this._lastLevel = now; this.levels = stereoLevels(buf); this.emit('levels', this.levels); }
    if (this.state !== 'recording') return;
    this.bytes += buf.length;
    if (this.link?.healthy && !this.queue.length && this.link.sendAudio(buf)) return;
    this.queue.push(buf);
    if (this.queue.length > MAX_QUEUE) { this.queue.shift(); this._pendingOffset += buf.length; if (!this._warnedDrop) { this._warnedDrop = true; this.log('error', 'Voicegain unreachable for too long; oldest audio is being dropped.'); } }
    if (this.link?.healthy) this._flushQueue();
  }

  _flushQueue() {
    while (this.queue.length && this.link?.healthy) { if (!this.link.sendAudio(this.queue[0])) break; this.queue.shift(); }
  }

  // ---------- Voicegain link ----------
  async _openLink() {
    if (this._opening || this.link) return;
    this._opening = true; this._setLink(this.linkCount ? 'reconnecting' : 'connecting');
    let sess;
    try {
      const hints = [...this.hints, ...this.book.roster, this.book.me];
      sess = await this.deps.startSession(this.cfg, { title: this.title, hints }, this.deps.fetchImpl);
      if (sess.warning) this.log('warn', sess.warning);
      if (this.linkCount > 0 || this._pendingOffset > 0) this.builder.beginSession(this._pendingOffset / 64);
      this._save('ws.jsonl', { k: 'session', offsetMs: this._pendingOffset / 64, sessionId: sess.sessionId });
      this.linkCount += 1;
      const link = this.deps.linkFactory(sess);
      link.on('payload', (p) => this._onPayload(p));
      link.on('error', (e) => this.log('warn', e.message));
      link.on('backpressure', () => { if (!this._warnedBp) { this._warnedBp = true; this.log('warn', 'Network is slow; audio is buffering.'); } });
      link.on('closed', (info) => this._onClosed(link, info));
      await link.connect();
      if (this.state === 'done') { await link.end(1000); return; }
      this.link = link; this.retries = 0; this._warnedBp = false;
      this._setLink('connected'); this._flushQueue();
    } catch (e) {
      this.log('error', e.message);
      const fatal = e.status === 401 || e.status === 400 || /No Voicegain JWT/.test(e.message);
      if (fatal || this.state === 'stopping') { this._setLink('failed'); if (fatal) this.log('error', 'Fix the problem above, then type /reconnect.'); } else this._scheduleRetry();
    } finally { this._opening = false; }
  }

  _onClosed(link, info) {
    if (link !== this.link) return;
    this.link = null;
    if (this.state === 'recording') {
      this.log('warn', `Voicegain connection lost (${info.which} socket${info.code ? `, code ${info.code}` : ''}). Reconnecting...`);
      this._pendingOffset = this.bytes; // frames from now on belong to the next session
      this._setLink('reconnecting'); this._scheduleRetry();
    } else if (this.state === 'paused') this._setLink('idle');
  }

  _scheduleRetry() {
    if (this.retries >= RETRY_MS.length) { this._setLink('failed'); this.log('error', 'Gave up reconnecting to Voicegain. Audio keeps buffering; type /reconnect to try again.'); return; }
    this._setLink('reconnecting');
    this._timer = setTimeout(() => { this.retries += 1; this._openLink(); }, RETRY_MS[this.retries]);
  }

  _onPayload(p) {
    this._save('ws.jsonl', { k: 'payload', t: Math.round(this.clockSec() * 100) / 100, p });
    if (this.builder.ingest(p)) this.emit('transcript');
  }

  // ---------- notes ----------
  addNote(kind, text) {
    const n = { t: Math.round(this.clockSec() * 10) / 10, kind, text: String(text).trim() };
    if (!n.text) return null;
    this.notes.push(n); this._save('notes.jsonl', n); this.emit('notes', n);
    return n;
  }
  addNoteLine(line) { const p = parseNoteLine(line); return p ? this.addNote(p.kind, p.text) : null; }

  // ---------- speakers ----------
  _spkTime() { return Math.max(0, this.clockSec() - this.cfg.speakerLagSec); }
  setSpeaker(arg) { const n = this.book.setCurrent(arg, this._spkTime()); if (n) { this._event({ type: 'speaker', name: n, t: this.book.timeline.at(-1).t }); this.emit('speakers'); } return n; }
  cycleSpeaker(dir = 1) { const n = this.book.cycle(dir, this._spkTime()); if (n) { this._event({ type: 'speaker', name: n, t: this.book.timeline.at(-1).t }); this.emit('speakers'); } return n; }
  addPerson(name) { const ok = this.book.add(name); if (ok) { this._event({ type: 'roster', roster: this.book.roster }); this.emit('speakers'); } return ok; }
  removePerson(arg) { const n = this.book.remove(arg); if (n) { this._event({ type: 'roster', roster: this.book.roster }); this.emit('speakers'); } return n; }
  setMe(name) { this.book.me = name; this._event({ type: 'me', name }); this.emit('speakers'); }
  setMode(mode) { this.book.mode = mode; this._event({ type: 'mode', mode }); this.emit('speakers'); }
  renameLabel(label, name) { const ok = this.book.rename(label, name); if (ok) { this._event({ type: 'label', label, name }); this.emit('speakers'); } return ok; }

  /** Attribute the most recent line (and what follows it) to someone else. */
  relabelLast(arg) {
    const lines = this.lines().filter((l) => this.book.mode === 'room' || l.chn !== 0 || l.diarized);
    const last = lines.at(-1);
    if (!last) return null;
    let name = this.book.lookup(arg);
    if (!name) { if (/^\d+$/.test(String(arg).trim())) return null; name = String(arg).trim(); this.book.add(name); }
    this.book.overrides.set(last.id, name); this._event({ type: 'override', id: last.id, name });
    this.book.current = name; this.book.timeline = this.book.timeline.filter((e) => e.t < last.t);
    this.book.timeline.push({ t: last.t, name }); this._event({ type: 'speaker', name, t: last.t });
    this.emit('speakers'); this.emit('transcript');
    return { name, text: last.text };
  }

  // ---------- transcript views ----------
  lines() {
    const nowMs = this.clockSec() * 1000;
    return this.builder.lines(nowMs).filter((l) => l.text.trim()).map((l) => ({
      id: l.id, t: l.tStart / 1000, tEnd: l.tEnd / 1000, speaker: this.book.displayFor(l), text: l.text, live: l.live, chn: l.chn, diarized: l.diarized,
    }));
  }

  participants(lines) {
    const out = [];
    const add = (n) => { if (n && !out.includes(n)) out.push(n); };
    if (this.book.mode !== 'room') add(this.book.me);
    this.book.roster.forEach(add);
    lines.forEach((l) => add(l.speaker));
    return out;
  }

  _writeMeta(extra = {}) {
    this.folder?.writeMeta({ app: 'meetbot', title: this.title, startedAt: this.startedAt?.toISOString(), durationSec: this.clockSec(), template: this.templateName,
      me: this.book.me, mode: this.book.mode, roster: this.book.roster, ...extra });
  }

  // ---------- outputs ----------
  async _finalize(doSummary) {
    const lines = this.lines().map((l) => ({ ...l, live: false }));
    const meta = { title: this.title, startedAt: this.startedAt, durationSec: this.clockSec(), participants: this.participants(lines) };
    const files = { transcript: this.folder.file('transcript.md'), notes: this.folder.file('personal-notes.md'), summary: this.folder.file('summary.md') };
    this.folder.write('transcript.md', renderTranscript({ ...meta, lines }));
    this.folder.write('personal-notes.md', renderPersonalNotes({ title: this.title, startedAt: this.startedAt, notes: this.notes }));
    this._writeMeta({ participants: meta.participants });

    let tpl; let warning = '';
    try { tpl = loadTemplate(this.templateName); } catch (e) { warning = e.message; tpl = loadTemplate('general-meeting'); }
    let summary; let title = this.title;
    if (!doSummary) summary = fallbackSummary({ meta, notes: this.notes, templateText: tpl.text, reason: 'skipped (--no-summary)' });
    else {
      try {
        this.emit('progress', 'Summarizing with the local model...');
        const r = await this.deps.summarizer({ cfg: this.cfg, meta, lines, notes: this.notes, templateText: tpl.text, fetchImpl: this.deps.fetchImpl, onProgress: (m) => this.emit('progress', m) });
        summary = r.markdown; title = this.title || r.title;
      } catch (e) {
        warning = `${warning} ${e.message}`.trim();
        summary = fallbackSummary({ meta, notes: this.notes, templateText: tpl.text, reason: e.message });
      }
    }
    this.folder.write('summary.md', summary);
    if (title && !this.title) { this.title = title; this.folder.write('transcript.md', renderTranscript({ ...meta, title, lines })); this.folder.write('personal-notes.md', renderPersonalNotes({ title, startedAt: this.startedAt, notes: this.notes })); }
    this._writeMeta({ participants: meta.participants, title: this.title });
    this.result = { dir: this.folder.dir, files, warning, summaryText: summary, lines: lines.length, durationSec: meta.durationSec };
    this._setState('done');
    this.emit('done', this.result);
    return this.result;
  }
}
