// Markdown for the transcript and the personal-notes files.
import { KINDS } from './notes.js';

export function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  const mm = String(m).padStart(2, '0'); const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const fmtTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** Merge consecutive lines by the same speaker (gap <= maxGap s) into readable turns. */
export function toTurns(lines, maxGap = 4) {
  const turns = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === l.speaker && l.t - last.tEnd <= maxGap) { last.tEnd = l.tEnd; last.text += ` ${l.text}`; }
    else turns.push({ t: l.t, tEnd: l.tEnd, speaker: l.speaker, text: l.text });
  }
  return turns;
}

export function renderTranscript({ title, startedAt, durationSec, participants, lines }) {
  const head = [`# Transcript: ${title || 'Meeting'}`, '', `- **Started:** ${fmtDate(startedAt)} ${fmtTime(startedAt)}`,
    `- **Duration:** ${fmtClock(durationSec)}`, `- **Speakers:** ${participants.join(', ') || 'n/a'}`, '', '---', ''];
  const body = toTurns(lines).map((t) => `**[${fmtClock(t.t)}] ${t.speaker}:** ${t.text}`);
  return `${head.join('\n')}${body.length ? body.join('\n\n') : '_No speech was transcribed._'}\n`;
}

export function renderPersonalNotes({ title, startedAt, notes }) {
  const head = [`# My notes: ${title || 'Meeting'}`, '', `_${fmtDate(startedAt)} ${fmtTime(startedAt)} - times are into the recording_`, ''];
  if (!notes.length) return `${head.join('\n')}_No personal notes were taken._\n`;
  const line = (n) => {
    const tag = n.kind === 'note' ? '' : `**${KINDS[n.kind]}:** `;
    const box = n.kind === 'action' ? '[ ] ' : '';
    return `- ${box}\`${fmtClock(n.t)}\` ${tag}${n.text}`;
  };
  return `${head.join('\n')}${notes.map(line).join('\n')}\n`;
}
