// Template "auto": pick the summary template from what the recording turned out to be, so one flow serves both
// meetings and personal voice notes. Rule: if (almost) everything was said by you, it is a voice note.
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;

/** Share of spoken words that came from `me` (0..1); 0 when nothing was said. */
export function mySpeechShare(lines, me) {
  let mine = 0; let all = 0;
  for (const l of lines) { const n = words(l.text); all += n; if (l.speaker === me) mine += n; }
  return all ? mine / all : 0;
}

export function resolveTemplate(name, { lines = [], me = '' } = {}) {
  if (name !== 'auto') return name;
  return mySpeechShare(lines, me) >= 0.9 ? 'voice-note' : 'general-meeting';
}
