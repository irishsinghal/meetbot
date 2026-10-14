// Plain-text mode: no full-screen UI. Prints the transcript as it settles and reads commands/notes line by line
// (also what you get when stdin/stdout is not a terminal).
import readline from 'node:readline';
import { runCommand } from '../commands.js';
import { fmtClock } from '../render.js';

export async function runPlain(session, { autoStart = true, input = process.stdin, out = process.stdout, stopAfterSourceEnd = true } = {}) {
  const say = (s) => out.write(`${s}\n`);
  const printed = new Set();
  const flush = (all = false) => {
    for (const l of session.lines()) if (!printed.has(l.id) && (all || !l.live)) { printed.add(l.id); say(`[${fmtClock(l.t)}] ${l.speaker}: ${l.text}`); }
  };
  session.on('log', (e) => say(`${e.level === 'info' ? '·' : e.level === 'warn' ? '!' : 'x'} ${e.text}`));
  session.on('progress', (t) => say(`… ${t}`));
  const timer = setInterval(() => flush(), 500);
  const done = new Promise((resolve) => session.once('done', resolve));
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', async (line) => { for (const m of await runCommand(session, line)) say(m.text); });
  rl.on('close', () => { if (session.state === 'recording' || session.state === 'paused') session.stop().catch(() => {}); });
  session.once('source-end', () => { if (stopAfterSourceEnd) setTimeout(() => session.stop().catch(() => {}), 4000); });

  say('MeetBot (plain mode). Type notes + Enter; /help for commands.');
  if (autoStart) { for (const m of await runCommand(session, '/start')) say(m.text); } else say('Type /start to begin.');
  const result = await done;
  if (session.finalizing) say('Saved a draft; improving the transcript and summary...');
  await session.whenFinalized();
  clearInterval(timer); flush(true); rl.close();
  say(`\nSaved to ${result.dir}\n  transcript.md · personal-notes.md · summary.md${result.warning ? `\n! ${result.warning}` : ''}`);
  return result;
}
