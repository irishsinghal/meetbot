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
import { resolveTemplate } from './summarize/auto.js';
import { redact } from './config.js';
import { writeLog } from './errlog.js';
import { catchUp as realCatchUp, catchUpText, explainMention as realExplain, mentionNames, mentionRegex, recentLines } from './catchup.js';
import { warmModel } from './summarize/ollama.js';
import { AUDIO_FILE, discardAudio, refineLines, sttReady } from './refine.js';
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
      refine: deps.refine || refineLines,
      warm: deps.warm || ((c) => warmModel({ url: c.llm.url, model: c.llm.model })),
      catchUp: deps.catchUp || realCatchUp,
      explainMention: deps.explainMention || realExplain,
      sttReady: deps.sttReady || (() => sttReady(cfg)),
    };
    this.recordAudio = !!cfg.recording?.enabled; // per-call switch, initial value from config; changed with /record before the call starts
    this._audio = null;
    this.finalizing = false; this.finalized = null;
    this.mentions = []; this._mentionSeen = new Set(); this._mentionTimer = null; this._lastMention = -1e9;
    this.on('transcript', () => this._watchMentions());
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
  log(level, text) { const e = { level, text: redact(text, this.cfg), at: Date.now() }; this.logs.push(e); writeLog(level, e.text); if (this.logs.length > 200) this.logs.shift(); this.emit('log', e); }
  clockSec() { return this.bytes / BYTES_PER_SEC; }
  _setState(s) { this.state = s; this.emit('state', s); }
  _setLink(s) { this.linkState = s; this.emit('link', s); }
  _event(obj) { try { this.folder?.appendJsonl('events.jsonl', { ...obj, at: this.clockSec() }); } catch { /* disk full etc: never crash the meeting */ } }
  _save(name, obj) { try { this.folder?.appendJsonl(name, obj); } catch { /* ignore */ } }

  /** Per-call switch for keeping the audio for a post-call local transcription. Only before the call starts. */
  setRecordAudio(on) { if (this.state !== 'ready') return false; this.recordAudio = !!on; this.emit('state', this.state); return true; }

  _openAudio() {
    if (!this.recordAudio) return;
    if (!this.deps.sttReady()) { this.recordAudio = false; this.log('warn', 'Audio is not being recorded: local transcription is not installed. Run "meetbot setup" to enable it.'); return; }
    try {
      const s = fs.createWriteStream(this.folder.data(AUDIO_FILE));
      s.on('error', (e) => { if (this._audio) { this._audio = null; this.recordAudio = false; this.log('error', `Audio recording stopped: ${e.message}`); } });
      this._audio = s; this._audioKept = true; this._writeMeta(); this._event({ type: 'audio', recorded: true });
      this.log('info', 'Recording audio locally for a cleaner transcript after the call (deleted afterwards).');
    } catch (e) { this.recordAudio = false; this.log('error', `Could not record audio: ${e.message}`); }
  }

  async _closeAudio() {
    const s = this._audio; this._audio = null;
    if (!s) return;
    await new Promise((resolve) => { s.once('error', resolve); s.end(resolve); });
  }

  // ---------- live help: catch me up, tagged alerts ----------
  /** What was just said (last `minutes` min), and whether anything was asked of you. Falls back to the raw lines if the model is down. */
  async catchUp(minutes = 5) {
    const lines = this.lines();
    let r;
    try { r = await this.deps.catchUp({ cfg: this.cfg, lines, me: this.book.me, minutes, fetchImpl: this.deps.fetchImpl }); } catch (e) {
      const recent = recentLines(lines, minutes).slice(-8);
      r = { summary: recent.map((l) => `${l.speaker}: ${l.text}`), asked: '', topic: '', from: recent[0]?.t ?? 0, to: recent.at(-1)?.tEnd ?? 0, fallback: `Local model unavailable (${e.message}); showing the last lines instead.` };
    }
    r.text = catchUpText(r) + (r.fallback ? `
! ${r.fallback}` : '');
    this.emit('catchup', r);
    return r;
  }

  _watchMentions() {
    const cfg = this.cfg.mentions || {};
    if (cfg.enabled === false || this.state !== 'recording' || this._mentionTimer) return;
    const re = mentionRegex(mentionNames(this.book.me, cfg.names));
    if (!re) return;
    const hit = this.lines().find((l) => !this._mentionSeen.has(l.id) && l.speaker !== this.book.me && !(l.chn === 0 && this.book.mode !== 'room') && re.test(l.text));
    if (!hit) return;
    this._mentionSeen.add(hit.id);
    if (hit.t - this._lastMention < 20) return; // one alert per burst
    this._lastMention = hit.t;
    // Let the sentence finish before asking why.
    this._mentionTimer = setTimeout(() => { this._mentionTimer = null; this._raiseMention(hit.id).catch(() => {}); }, 3500);
  }

  async _raiseMention(id) {
    const lines = this.lines(); const l = lines.find((x) => x.id === id);
    if (!l) return;
    const m = { id, t: l.t, speaker: l.speaker, quote: l.text, why: '', needsResponse: false };
    this.mentions.push(m); this.emit('mention', { ...m });
    try { const r = await this.deps.explainMention({ cfg: this.cfg, lines, me: this.book.me, mention: m, fetchImpl: this.deps.fetchImpl }); m.why = String(r.why || '').trim(); m.needsResponse = !!r.needsResponse; } catch { /* model unavailable: the quote alone is shown */ }
    this._event({ type: 'mention', id, speaker: m.speaker, quote: m.quote, why: m.why });
    if (this.state === 'recording' || this.state === 'paused') this.addNote('flag', `Mentioned by ${m.speaker}: ${m.why || m.quote}`);
    this.emit('mention', { ...m });
  }

  // ---------- lifecycle ----------
  async start() {
    if (this.state !== 'ready') return false;
    this.startedAt = this.deps.now();
    this.folder = new MeetingFolder(this.cfg.outputDir, this.startedAt, this.cfg.folderLayout);
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
    this._openAudio();
    this.deps.warm(this.cfg); // load the local model now so catch-up / tag alerts answer fast
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
    await this._closeAudio();
    return this._finalize(summarize);
  }

  // ---------- audio ----------
  _onFrame(buf) {
    const now = Date.now();
    if (now - this._lastLevel > 120) { this._lastLevel = now; this.levels = stereoLevels(buf); this.emit('levels', this.levels); }
    if (this.state !== 'recording') return;
    this.bytes += buf.length;
    if (this._audio) { try { this._audio.write(buf); } catch { /* never crash the meeting */ } }
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
      this.log('warn', `Voicegain connection lost (${info.which} socket${info.code ? `, code ${info.code}` : ''}${info.reason ? `, reason "${info.reason}"` : ''}, session ${link.s?.sessionId}). Reconnecting...`);
      this._pendingOffset = this.bytes; // frames from now on belong to the next session
      // The server ends a session a few seconds after speech stops (clean close, code 1000): reopen right away.
      this._setLink('reconnecting'); this._scheduleRetry(info.code === 1000 ? 100 : undefined);
    } else if (this.state === 'paused') this._setLink('idle');
  }

  _scheduleRetry(delayMs) {
    if (delayMs === undefined && this.retries >= RETRY_MS.length) { this._setLink('failed'); this.log('error', 'Gave up reconnecting to Voicegain. Audio keeps buffering; type /reconnect to try again.'); return; }
    this._setLink('reconnecting');
    this._timer = setTimeout(() => { if (delayMs === undefined) this.retries += 1; this._openLink(); }, delayMs ?? RETRY_MS[this.retries]);
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
    this.folder?.writeMeta({ app: 'meetbot', title: this.title, startedAt: this.startedAt?.toISOString(), durationSec: this.clockSec(), template: this.resolvedTemplate || this.templateName, kind: this.resolvedTemplate === 'voice-note' ? 'voice-note' : this.resolvedTemplate ? 'meeting' : undefined,
      me: this.book.me, mode: this.book.mode, roster: this.book.roster, audio: !!this._audioKept, ...extra });
  }

  // ---------- outputs ----------
  // Two phases so stopping feels instant: first the files exist at once (live transcript, notes, a draft summary with
  // your notes), the session is "done" and the UI shows them; then, in the background, the local Whisper pass (if audio
  // was recorded) and the model summary replace the draft. `finalized` resolves when that is complete; it never rejects.
  async _finalize(doSummary) {
    const lines = this.lines().map((l) => ({ ...l, live: false }));
    const meta = { title: this.title, startedAt: this.startedAt, durationSec: this.clockSec(), participants: this.participants(lines) };
    const files = { transcript: this.folder.file('transcript.md'), notes: this.folder.file('personal-notes.md'), summary: this.folder.file('summary.md') };
    this.folder.write('transcript.md', renderTranscript({ ...meta, lines }));
    this.folder.write('personal-notes.md', renderPersonalNotes({ title: this.title, startedAt: this.startedAt, notes: this.notes }));

    let warning = '';
    this.resolvedTemplate = resolveTemplate(this.templateName, { lines, me: this.book.me });
    let tpl; try { tpl = loadTemplate(this.resolvedTemplate); } catch (e) { warning = e.message; tpl = loadTemplate('general-meeting'); }
    const audioPath = this.folder.data(AUDIO_FILE);
    const refinePending = this.recordAudio && fs.existsSync(audioPath) && this.bytes > 0;
    if (!this.recordAudio) { try { fs.rmSync(audioPath, { force: true }); } catch { /* ignore */ } }
    const more = refinePending || doSummary;
    const draft = fallbackSummary({ meta, notes: this.notes, templateText: tpl.text, reason: more ? '' : 'skipped (--no-summary)', draft: more });
    this.folder.write('summary.md', draft);
    this._writeMeta({ participants: meta.participants });
    this.result = { dir: this.folder.dir, files, warning, summaryText: draft, lines: lines.length, durationSec: meta.durationSec, draft: more };
    this._setState('done');
    this.emit('done', this.result);
    this.finalized = more ? this._improve({ lines, meta, tpl, doSummary, refinePending, audioPath }).catch((e) => this.log('error', `Finishing the notes failed: ${e.message}`)).then(() => { this.result.draft = false; this.emit('progress', ''); this.emit('finalized', this.result); return this.result; }) : Promise.resolve(this.result);
    return this.result;
  }

  async _improve({ lines, meta, tpl, doSummary, refinePending, audioPath }) {
    const r = this.result; const note = (w) => { r.warning = `${r.warning} ${w}`.trim(); };
    this.finalizing = true;
    try {
      if (refinePending) {
        try {
          this.emit('progress', 'Improving the transcript locally...');
          const refined = await this.deps.refine({ cfg: this.cfg, audioPath, liveLines: lines, book: this.book, hints: [...this.hints, ...this.book.roster, this.book.me], onProgress: (m) => this.emit('progress', m) });
          lines = refined; meta.participants = this.participants(lines); r.lines = lines.length;
          this.folder.write('transcript.md', renderTranscript({ ...meta, lines }));
          discardAudio(this.folder.dir); this._audioKept = false;
          this.resolvedTemplate = resolveTemplate(this.templateName, { lines, me: this.book.me });
          try { tpl = loadTemplate(this.resolvedTemplate); } catch { /* keep the earlier template */ }
        } catch (e) {
          const w = `Local re-transcription failed (${e.message}); kept the live transcript and the recording. Retry with: meetbot retranscribe "${this.folder.dir}"`;
          this.log('error', w); note(w);
        }
      }
      let summary = r.summaryText; let title = this.title;
      if (doSummary) {
        try {
          this.emit('progress', 'Writing the summary with the local model...');
          const out = await this.deps.summarizer({ cfg: this.cfg, meta, lines, notes: this.notes, templateText: tpl.text, fetchImpl: this.deps.fetchImpl, onProgress: (m) => this.emit('progress', m) });
          summary = out.markdown; title = this.title || out.title;
        } catch (e) { note(e.message); summary = fallbackSummary({ meta, notes: this.notes, templateText: tpl.text, reason: e.message }); }
      } else summary = fallbackSummary({ meta, notes: this.notes, templateText: tpl.text, reason: 'skipped (--no-summary)' });
      this.folder.write('summary.md', summary); r.summaryText = summary;
      if (title && !this.title) { this.title = title; this.folder.write('transcript.md', renderTranscript({ ...meta, title, lines })); this.folder.write('personal-notes.md', renderPersonalNotes({ title, startedAt: this.startedAt, notes: this.notes })); }
      this._writeMeta({ participants: meta.participants, title: this.title });
    } finally { this.finalizing = false; }
  }

  /** Resolves when the background improvement (Whisper pass + model summary) has finished. Never rejects. */
  whenFinalized() { return this.finalized || Promise.resolve(this.result); }
}
