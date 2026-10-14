// Fills a Markdown template from the transcript + your personal notes using the local LLM.
// Long meetings: each chunk is summarized into the same sections, then the drafts are merged.
import { KINDS } from '../notes.js';
import { fmtClock, fmtDate, fmtTime, toTurns } from '../render.js';
import { chatJson } from './ollama.js';
import { fillTemplate, parseSlots } from './template.js';

const RULES = `You write meeting notes from a transcript. Rules:
- Use ONLY what is stated in the transcript and in the lines tagged "MY NOTE" (typed by the user during the meeting). MY NOTE lines are authoritative: include their content, and treat [ACTION ITEM], [DECISION], [OPEN QUESTION] and [IMPORTANT MOMENT] tags literally.
- Never invent names, dates, numbers, decisions or owners. If something is unknown, leave it out or say it is unclear.
- Speaker names appear as shown. "Remote" and "Speaker N" are unidentified people.
- Return JSON with exactly the keys listed below. Every value is Markdown for that section WITHOUT its heading.
- Where an instruction asks for a list, use "- " bullets. If a section has nothing to report, write "None recorded."`;

export function transcriptText(lines, notes) {
  const rows = [
    ...lines.map((l) => ({ t: l.t, s: `[${fmtClock(l.t)}] ${l.speaker}: ${l.text}` })),
    ...notes.map((n) => ({ t: n.t, s: `[${fmtClock(n.t)}] MY NOTE${n.kind === 'note' ? '' : ` [${{ action: 'ACTION ITEM', decision: 'DECISION', question: 'OPEN QUESTION', flag: 'IMPORTANT MOMENT' }[n.kind]}]`}: ${n.text}` })),
  ].sort((a, b) => a.t - b.t);
  return rows.map((r) => r.s);
}

export function chunkRows(rows, maxChars) {
  const chunks = []; let cur = []; let size = 0;
  for (const r of rows) {
    if (cur.length && size + r.length > maxChars) { chunks.push(cur.join('\n')); cur = []; size = 0; }
    cur.push(r); size += r.length + 1;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

const words = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
export function similar(a, b) {
  const x = a.toLowerCase().trim(); const y = b.toLowerCase();
  if (y.includes(x)) return true;
  const A = words(a); const B = words(b); if (!A.size) return true;
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  return hit / A.size >= 0.6;
}

/** Guarantee that what YOU flagged (/a /d /q) shows up, even if the model paraphrased or skipped it. */
export function ensureNoteItems(ai, notes, me) {
  const map = { actions: 'action', decisions: 'decision', questions: 'question' };
  for (const [key, kind] of Object.entries(map)) {
    if (!(key in ai)) continue;
    for (const n of notes.filter((x) => x.kind === kind)) {
      if (similar(n.text, ai[key])) continue;
      const item = kind === 'action' ? `- [ ] **${me}**: ${n.text}` : `- ${n.text}`;
      ai[key] = /^\s*(?:[-*]\s*)?(?:none recorded\.?)?\s*$/i.test(ai[key]) ? item : `${ai[key].trimEnd()}\n${item}`;
    }
  }
  return ai;
}

export function personalNotesMd(notes) {
  if (!notes.length) return '_No personal notes were taken._';
  return notes.map((n) => `- \`${fmtClock(n.t)}\` ${n.kind === 'note' ? '' : `**${KINDS[n.kind]}:** `}${n.text}`).join('\n');
}

export function builtinsFor(meta, notes) {
  return { title: meta.title || 'Meeting', date: fmtDate(meta.startedAt), time: fmtTime(meta.startedAt), duration: fmtClock(meta.durationSec),
    participants: meta.participants.join(', ') || 'n/a', personal_notes: personalNotesMd(notes) };
}

export async function summarize({ cfg, meta, lines, notes, templateText, fetchImpl = fetch, onProgress = () => {} }) {
  const slots = parseSlots(templateText);
  const needsTitle = /\{\{\s*title\s*\}\}/.test(templateText) && !meta.title;
  const keys = [...slots.map((s) => s.key), ...(needsTitle ? ['meeting_title'] : [])];
  const instr = [...slots.map((s) => `- ${s.key}: ${s.instruction}`), ...(needsTitle ? ['- meeting_title: a short descriptive title (max 8 words), plain text'] : [])].join('\n');
  const schema = { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, { type: 'string' }])), required: keys };
  const header = `Meeting: ${meta.title || '(untitled)'}; ${fmtDate(meta.startedAt)}; duration ${fmtClock(meta.durationSec)}; participants: ${meta.participants.join(', ') || 'unknown'}`;
  const call = (system, user) => chatJson({ url: cfg.llm.url, model: cfg.llm.model, ctx: cfg.llm.ctx, system, user, schema, fetchImpl });

  const rows = transcriptText(toTurns(lines), notes);
  let ai = {};
  if (keys.length) {
    const chunks = chunkRows(rows, cfg.llm.chunkChars);
    if (!chunks.length) ai = Object.fromEntries(keys.map((k) => [k, k === 'meeting_title' ? 'Empty recording' : 'None recorded.']));
    else if (chunks.length === 1) { onProgress('Summarizing...'); ai = await call(`${RULES}\n\nKeys:\n${instr}`, `${header}\n\nTRANSCRIPT:\n${chunks[0]}`); }
    else {
      const partials = [];
      for (let i = 0; i < chunks.length; i++) {
        onProgress(`Summarizing part ${i + 1}/${chunks.length}...`);
        partials.push(await call(`${RULES}\n\nThis is PART ${i + 1} of ${chunks.length} of one meeting; write notes for this part only.\n\nKeys:\n${instr}`, `${header}\n\nTRANSCRIPT PART:\n${chunks[i]}`));
      }
      onProgress('Merging notes...');
      ai = await call(`${RULES}\n\nMerge the partial notes of consecutive parts of ONE meeting: deduplicate, keep order, keep every action item and decision, and write one coherent result.\n\nKeys:\n${instr}`,
        `${header}\n\n${partials.map((p, i) => `--- PART ${i + 1} NOTES ---\n${JSON.stringify(p, null, 1)}`).join('\n\n')}`);
    }
    for (const k of keys) ai[k] = String(ai[k] ?? '').trim() || 'None recorded.';
    ensureNoteItems(ai, notes, cfg.me);
  }
  const builtins = builtinsFor({ ...meta, title: meta.title || ai.meeting_title }, notes);
  return { markdown: fillTemplate(templateText, builtins, ai), title: builtins.title };
}

/** Used when the LLM is unavailable: keeps the file structure and your notes, marks AI sections as missing. */
export function fallbackSummary({ meta, notes, templateText, reason, draft = false }) {
  const body = fillTemplate(templateText, builtinsFor(meta, notes), {});
  if (draft) return `> **Draft:** your notes are below; the full summary is still being written and will replace this file.

${body}`;
  return `> **Summary not generated:** ${reason}\n> Re-run with: \`meetbot summarize <this folder>\`\n\n${body}`;
}
