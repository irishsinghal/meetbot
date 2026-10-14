// Live help during a call, all with the local model: "catch me up" (what was just said) and "why was I tagged"
// (someone said your name). Both work from the live transcript lines [{t, speaker, text}].
import { fmtClock } from './render.js';
import { chatJson } from './summarize/ollama.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names that count as "being tagged": your name, its first word, plus configured aliases. "You" (the default) is ignored. */
export function mentionNames(me, extra = []) {
  const out = new Set();
  for (const n of [me, String(me || '').split(/\s+/)[0], ...extra]) { const t = String(n || '').trim(); if (t.length >= 3 && t.toLowerCase() !== 'you') out.add(t); }
  return [...out];
}

export function mentionRegex(names) {
  if (!names.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

const FAST = { ctx: 4096, maxTokens: 350 }; // live helpers must answer in seconds: small context, short output
/** Transcript rows, keeping only the newest ~maxChars so the prompt stays small. */
const rowsOf = (lines, maxChars = 7000) => {
  const rows = lines.map((l) => `[${fmtClock(l.t)}] ${l.speaker}: ${l.text}`); let size = 0; const keep = [];
  for (let i = rows.length - 1; i >= 0 && size + rows[i].length <= maxChars; i--) { keep.unshift(rows[i]); size += rows[i].length + 1; }
  return keep.join('\n');
};

/** Lines from the last `minutes` of the call (relative to the newest line). */
export function recentLines(lines, minutes) {
  if (!lines.length) return [];
  const end = lines[lines.length - 1].tEnd ?? lines[lines.length - 1].t;
  return lines.filter((l) => l.t >= end - minutes * 60);
}

const SYS = 'You help a participant of a live meeting. Be brief and concrete. Use ONLY the transcript; never invent facts. "Remote" and "Speaker N" are unidentified people. Return JSON only.';

/** Quick recap. -> {summary: string[], asked: string, topic: string, from, to} (throws OllamaError if the model is unavailable). */
export async function catchUp({ cfg, lines, me, minutes = 5, fetchImpl = fetch }) {
  const recent = recentLines(lines, minutes);
  if (!recent.length) return { summary: [], asked: '', topic: '', from: 0, to: 0 };
  const schema = { type: 'object', required: ['summary', 'asked', 'topic'], properties: {
    summary: { type: 'array', items: { type: 'string' }, description: 'at most 5 short bullets, newest last' },
    asked: { type: 'string', description: `what was asked of, or assigned to, "${me}" (empty string if nothing)` },
    topic: { type: 'string', description: 'the topic being discussed right now, in a few words' } } };
  const r = await chatJson({ url: cfg.llm.url, model: cfg.llm.model, ...FAST, system: SYS, schema, fetchImpl,
    user: `The user is "${me}" and just looked away. Summarize the last ${minutes} minutes so they can rejoin the conversation, and say if anyone asked or assigned something to them.\n\nTRANSCRIPT:\n${rowsOf(recent)}` });
  return { summary: (r.summary || []).slice(0, 5), asked: String(r.asked || '').trim(), topic: String(r.topic || '').trim(), from: recent[0].t, to: recent.at(-1).tEnd ?? recent.at(-1).t };
}

/** Why was `me` tagged at `mention` ({t, speaker, text})? -> {why: string, needsResponse: boolean}. */
export async function explainMention({ cfg, lines, me, mention, fetchImpl = fetch }) {
  const ctx = lines.filter((l) => l.t >= mention.t - 90 && l.t <= mention.t + 30);
  const schema = { type: 'object', required: ['why', 'needsResponse'], properties: {
    why: { type: 'string', description: `one or two sentences: what ${mention.speaker} wants from, or said about, "${me}"` },
    needsResponse: { type: 'boolean', description: `true if "${me}" is expected to answer or act` } } };
  return chatJson({ url: cfg.llm.url, model: cfg.llm.model, ...FAST, system: SYS, schema, fetchImpl,
    user: `The user is "${me}". At [${fmtClock(mention.t)}] ${mention.speaker} mentioned them. Say why, using the conversation around it.\n\nTRANSCRIPT:\n${rowsOf(ctx)}` });
}

/** Plain-text rendering of a catch-up result (terminal / status line). */
export function catchUpText(r) {
  if (!r.summary.length && !r.asked) return 'Nothing has been said yet.';
  const head = `Last ${fmtClock(r.from)}–${fmtClock(r.to)}${r.topic ? ` · ${r.topic}` : ''}`;
  return [head, ...r.summary.map((b) => `- ${b}`), ...(r.asked ? [`> For you: ${r.asked}`] : [])].join('\n');
}
