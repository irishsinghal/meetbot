// Personal notes typed during the meeting. Prefix a line to tag it:
//   /a action item   /d decision   /q open question   /f flag this moment      (no prefix = plain note)
export const KINDS = { note: 'Note', action: 'Action', decision: 'Decision', question: 'Question', flag: 'Flag' };
const PREFIX = { '/a': 'action', '/todo': 'action', '/d': 'decision', '/q': 'question', '/f': 'flag', '/n': 'note', '/note': 'note' };

/** -> {kind, text} or null for a non-note line. A bare "/f" is allowed (flag with no text). */
export function parseNoteLine(line) {
  const s = String(line ?? '').trim();
  if (!s) return null;
  if (!s.startsWith('/')) return { kind: 'note', text: s };
  const [head, ...rest] = s.split(/\s+/);
  const kind = PREFIX[head.toLowerCase()];
  if (!kind) return null;
  const text = rest.join(' ').trim();
  if (!text) return kind === 'flag' ? { kind, text: 'Important moment' } : null;
  return { kind, text };
}

export const isNoteCommand = (head) => head.toLowerCase() in PREFIX;
