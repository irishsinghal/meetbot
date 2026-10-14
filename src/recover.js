// Rebuild a finished (or crashed) meeting from its .data/ folder, e.g. to re-run the summary with another template.
import fs from 'node:fs';
import path from 'node:path';
import { SpeakerBook } from './speakers.js';
import { readJsonl } from './storage.js';
import { fallbackSummary, summarize as realSummarize } from './summarize/index.js';
import { loadTemplate } from './summarize/template.js';
import { TranscriptBuilder } from './voicegain/transcript.js';

export function loadMeeting(dir, cfg) {
  const data = path.join(dir, '.data');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(data, 'meeting.json'), 'utf8')); } catch { throw new Error(`${dir} is not a MeetBot folder (no .data/meeting.json)`); }
  const builder = new TranscriptBuilder({ lineGapMs: cfg.voicegain.lineGapMs });
  let seen = false; let lastT = 0;
  for (const e of readJsonl(path.join(data, 'ws.jsonl'))) {
    if (e.k === 'session') { if (seen) builder.beginSession(e.offsetMs); seen = true; } else if (e.k === 'payload') { builder.ingest(e.p); lastT = Math.max(lastT, e.t || 0); }
  }
  const book = new SpeakerBook({ me: meta.me || cfg.me, mode: meta.mode || 'call', roster: meta.roster || [] });
  for (const e of readJsonl(path.join(data, 'events.jsonl'))) {
    if (e.type === 'me') book.me = e.name;
    else if (e.type === 'mode') book.mode = e.mode;
    else if (e.type === 'roster') (e.roster || []).forEach((n) => book.add(n));
    else if (e.type === 'speaker') book.setCurrent(e.name, e.t);
    else if (e.type === 'label') book.rename(e.label, e.name);
    else if (e.type === 'override') book.overrides.set(e.id, e.name);
  }
  const notes = readJsonl(path.join(data, 'notes.jsonl'));
  const lines = builder.lines(Infinity).filter((l) => l.text.trim()).map((l) => ({
    id: l.id, t: l.tStart / 1000, tEnd: l.tEnd / 1000, speaker: book.displayFor(l), text: l.text, live: false, chn: l.chn, diarized: l.diarized }));
  const participants = [];
  const add = (n) => { if (n && !participants.includes(n)) participants.push(n); };
  if (book.mode !== 'room') add(book.me);
  book.roster.forEach(add); lines.forEach((l) => add(l.speaker));
  return { meta: { title: meta.title || '', startedAt: new Date(meta.startedAt), durationSec: meta.durationSec || lastT, participants, template: meta.template }, lines, notes };
}

/** Regenerate summary.md (the previous one is kept as summary.previous.md). */
export async function resummarize(dir, cfg, { template, summarizer = realSummarize, fetchImpl = fetch, onProgress } = {}) {
  const { meta, lines, notes } = loadMeeting(dir, cfg);
  const tpl = loadTemplate(template || meta.template || cfg.template);
  let md; let warning = '';
  try { md = (await summarizer({ cfg, meta, lines, notes, templateText: tpl.text, fetchImpl, onProgress })).markdown; } catch (e) { warning = e.message; md = fallbackSummary({ meta, notes, templateText: tpl.text, reason: e.message }); }
  const out = path.join(dir, 'summary.md');
  if (fs.existsSync(out)) fs.copyFileSync(out, path.join(dir, 'summary.previous.md'));
  fs.writeFileSync(out, md, 'utf8');
  return { file: out, warning, template: tpl.name };
}
