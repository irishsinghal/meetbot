// Rebuilds the transcript from the websocket stream. Words can be revised later (wordEdit), so we keep every
// word per speaker and group them into lines on demand instead of committing text early.
import { parsePayload } from './parse.js';

const PUNCT = /^[.,!?;:%)\]}"”’']+$/;

export class TranscriptBuilder {
  constructor({ lineGapMs = 1500, maxWordsPerLine = 70 } = {}) {
    this.lineGapMs = lineGapMs;
    this.maxWords = maxWordsPerLine;
    this.sess = 0;
    this.offsetMs = 0;
    this.speakers = new Map();   // skey -> {spk, chn, agent, diarized}
    this.words = new Map();      // skey -> word[]
    this.segments = [];          // final segments (segments mode)
    this.partials = new Map();   // skey -> hypothesis segment (segments mode)
    this.analytics = [];         // passthrough events
    this.lastMs = 0;             // newest audio position seen
    this.version = 0;
  }

  /** Call when a new Voicegain session starts mid-meeting (reconnect/resume). offsetMs = audio already sent. */
  beginSession(offsetMs) { this.sess += 1; this.offsetMs = offsetMs; }

  key(spk) { return `${this.sess}:${spk ?? 0}`; }

  ingest(msg) {
    const p = parsePayload(msg);
    if (!p) return false;
    let changed = false;
    for (const s of p.speakers) { this.speakers.set(this.key(s.spk), s); changed = true; }
    for (const w of p.words) { this._push(this.key(w.spk), w); changed = true; }
    for (const e of p.edits) {
      const k = this.key(e.spk ?? e.words[0]?.spk);
      const list = this.words.get(k) || [];
      if (e.del > 0) list.length = Math.max(0, list.length - e.del);
      this.words.set(k, list);
      for (const w of e.words) this._push(k, w);
      changed = true;
    }
    for (const s of p.segments) {
      const k = this.key(s.spk);
      const seg = { ...s, start: s.start + this.offsetMs, end: s.end + this.offsetMs, skey: k, spk: s.spk };
      if (s.final) { if (seg.text) this.segments.push(seg); this.partials.delete(k); } else this.partials.set(k, seg);
      this.lastMs = Math.max(this.lastMs, seg.end);
      changed = true;
    }
    for (const [type, items] of Object.entries(p.analytics)) { this.analytics.push({ type, items }); }
    if (changed) this.version += 1;
    return changed;
  }

  _push(k, w) {
    const ww = { ...w, start: w.start + this.offsetMs, end: w.end + this.offsetMs };
    if (!this.words.has(k)) this.words.set(k, []);
    this.words.get(k).push(ww);
    this.lastMs = Math.max(this.lastMs, ww.end);
  }

  _info(skey) {
    const known = this.speakers.get(skey); if (known) return known;
    // Some servers (Ascalon) send no speaker[] messages: speaker 1 is then the left channel (mic), 2 the right (system).
    const spk = Number(skey.split(':')[1]);
    return { spk, chn: spk === 1 ? 0 : spk === 2 ? 1 : undefined, agent: false, diarized: false };
  }

  /** All transcript lines in time order. `live` marks text that may still be revised (newer than liveMs). */
  lines(nowMs = this.lastMs, liveMs = 2500) {
    const out = [];
    for (const [skey, list] of this.words) {
      let cur = null;
      for (const w of list) {
        const gap = cur ? w.start - cur.tEnd : 0;
        if (!cur || gap > this.lineGapMs || cur.n >= this.maxWords) {
          if (cur) out.push(cur);
          cur = { skey, tStart: w.start, tEnd: w.end, text: '', n: 0 };
        }
        cur.text += (cur.text && !PUNCT.test(w.text) ? ' ' : '') + w.text;
        cur.tEnd = Math.max(cur.tEnd, w.end);
        cur.n += 1;
      }
      if (cur) out.push(cur);
    }
    for (const s of this.segments) out.push({ skey: s.skey, tStart: s.start, tEnd: s.end, text: s.text, n: 1 });
    for (const s of this.partials.values()) if (s.text) out.push({ skey: s.skey, tStart: s.start, tEnd: s.end, text: s.text, n: 1, partial: true });
    return out
      .map((l) => {
        const info = this._info(l.skey);
        return { id: `${l.skey}@${l.tStart}`, skey: l.skey, spk: info.spk, chn: info.chn, agent: info.agent, diarized: info.diarized,
          tStart: l.tStart, tEnd: l.tEnd, text: l.text, live: !!l.partial || l.tEnd > nowMs - liveMs };
      })
      .sort((a, b) => a.tStart - b.tStart || (a.chn ?? 0) - (b.chn ?? 0));
  }
}
