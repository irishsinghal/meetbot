// `meetbot probe`: open a real Voicegain session for a few seconds and show the raw websocket messages.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config.js';
import { startSession, VoicegainLink } from './voicegain/client.js';
import { parsePayload } from './voicegain/parse.js';

export async function probe(cfg, { seconds = 15, source, print = console.log }) {
  print(`Starting a ${seconds}s test session. Speak, and/or play something on this PC...`);
  const sess = await startSession(cfg, { title: 'meetbot-probe' });
  if (sess.warning) print(`! ${sess.warning}`);
  print(`Session ${sess.sessionId} created. speakerChannels: ${JSON.stringify(sess.speakerChannels ?? null)}`);
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), `probe-${Date.now()}.jsonl`);
  const link = new VoicegainLink(sess);
  let n = 0;
  link.on('raw', (t) => { n += 1; fs.appendFileSync(file, `${t}\n`); const p = parsePayload(safe(t)); print(`< ${t.length > 400 ? `${t.slice(0, 400)}…` : t}`); if (p && (p.words.length || p.segments.length)) print(`  = ${p.words.length} words, ${p.segments.length} segments`); });
  link.on('error', (e) => print(`! ${e.message}`));
  await link.connect();
  source.on('data', (f) => link.sendAudio(f));
  await source.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  await source.stop(); await link.end();
  print(`\n${n} messages received. Raw log: ${file}`);
  return { file, count: n };
}
const safe = (t) => { try { return JSON.parse(t); } catch { return null; } };
