// Who is talking. Voicegain gives us channels (L = your mic, R = system audio) and, optionally, diarized speaker
// ids. Within the remote channel you tell MeetBot who is speaking (Tab / number keys / /speaker), and it keeps a
// timeline so lines are attributed by the time they were spoken.
import fs from 'node:fs';
import path from 'node:path';

const norm = (s) => String(s).trim().toLowerCase();

export class SpeakerBook {
  constructor({ me = 'You', roster = [], mode = 'call' } = {}) {
    this.me = me; this.roster = []; this.mode = mode; // 'call' = mic is you, system is others; 'room' = everyone picked manually
    this.current = null; this.timeline = []; this.labelMap = {}; this.overrides = new Map();
    roster.forEach((n) => this.add(n));
  }

  add(name) {
    const n = String(name).trim();
    if (!n || this.roster.some((r) => norm(r) === norm(n))) return false;
    this.roster.push(n); return true;
  }

  remove(arg) {
    const name = this.lookup(arg);
    if (!name) return null;
    this.roster = this.roster.filter((r) => r !== name);
    if (this.current === name) this.current = null;
    return name;
  }

  /** "2" -> second roster entry, "priya" -> "Priya" (case-insensitive, unique prefix ok). null if unknown. */
  lookup(arg) {
    const a = String(arg ?? '').trim();
    if (!a) return null;
    if (/^\d+$/.test(a)) return this.roster[Number(a) - 1] ?? null;
    const exact = this.roster.find((r) => norm(r) === norm(a));
    if (exact) return exact;
    const pre = this.roster.filter((r) => norm(r).startsWith(norm(a)));
    return pre.length === 1 ? pre[0] : null;
  }

  /** Make `arg` (roster number or name; unknown names are added) the current speaker from `atSec` onward. */
  setCurrent(arg, atSec = 0) {
    let name = this.lookup(arg);
    if (!name) {
      if (/^\d+$/.test(String(arg).trim())) return null;
      name = String(arg).trim(); if (!name) return null; this.add(name);
    }
    this.current = name;
    this.timeline = this.timeline.filter((e) => e.t < atSec); // a newer decision supersedes later entries
    this.timeline.push({ t: Math.max(0, atSec), name });
    return name;
  }

  cycle(dir = 1, atSec = 0) {
    if (!this.roster.length) return null;
    const i = this.current ? this.roster.indexOf(this.current) : -1;
    const next = this.roster[(i + dir + this.roster.length * 2) % this.roster.length];
    return this.setCurrent(next, atSec);
  }

  speakerAt(sec) {
    let name = null;
    for (const e of this.timeline) { if (e.t <= sec + 1e-6) name = e.name; else break; }
    return name;
  }

  /** Name Voicegain's diarized speaker N ("Speaker 2") after a real person. */
  rename(label, name) {
    const m = /^(?:speaker\s*)?(\d+)$/i.exec(String(label).trim());
    if (!m) return false;
    this.labelMap[`d${m[1]}`] = String(name).trim(); this.add(name); return true;
  }

  /** Display name for a transcript line {id, chn, spk, diarized, tStart(ms)}. */
  displayFor(line) {
    const o = this.overrides.get(line.id);
    if (o) return o;
    if (line.diarized) return this.labelMap[`d${line.spk}`] || `Speaker ${line.spk}`;
    if (line.chn === 0 && this.mode !== 'room') return this.me;
    return this.speakerAt(line.tStart / 1000) || (this.mode === 'room' ? 'Speaker' : 'Remote');
  }

  toJSON() { return { me: this.me, roster: this.roster, mode: this.mode, timeline: this.timeline, labelMap: this.labelMap, overrides: [...this.overrides] }; }
}

export class PresetStore {
  constructor(dir) { this.dir = dir; }
  file(name) { return path.join(this.dir, `${String(name).replace(/[^\w.-]+/g, '_')}.json`); }
  list() { try { return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; } }
  save(name, book, extra = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(name), JSON.stringify({ me: book.me, mode: book.mode, participants: book.roster, ...extra }, null, 2));
  }
  load(name) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return null; }
  }
  remove(name) { try { fs.unlinkSync(this.file(name)); return true; } catch { return false; } }
}
