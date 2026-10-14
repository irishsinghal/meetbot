import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaults } from '../src/config.js';
import { MeetingSession } from '../src/session.js';
import { FileSource } from '../src/audio/source.js';
import { writeWav } from '../src/audio/wav.js';
import { runCommand } from '../src/commands.js';
import { loadMeeting, resummarize } from '../src/recover.js';
import { startMockVoicegain, meetingScript, SPEAKERS } from './helpers/mock-voicegain.js';
import { startMockOllama } from './helpers/mock-ollama.js';

const tmp = (p = 'mb-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 2)); } throw new Error(`timeout waiting for ${fn}`); };
const wavFile = (sec = 9) => { const f = path.join(tmp(), 'meeting.wav'); fs.writeFileSync(f, writeWav({ channels: 2, rate: 16000, samples: new Int16Array(16000 * 2 * sec).fill(500) })); return f; };

function setup(vg, ol, extra = {}) {
  const cfg = defaults();
  Object.assign(cfg.voicegain, { baseUrl: vg.baseUrl, jwt: vg.jwt, saConfig: vg.saConfig, ...extra });
  cfg.llm.url = ol.url; cfg.outputDir = tmp('out-'); cfg.me = 'Rishabh';
  const wav = wavFile();
  const session = new MeetingSession(cfg, { sourceFactory: () => new FileSource(wav, { speed: 10 }) });
  return { cfg, session, wav };
}
const finish = async (session) => { await new Promise((r) => session.once('source-end', r)); return session.stop(); };

test('full meeting: live transcript, speakers, notes, three output files, local summary', async (t) => {
  const vg = await startMockVoicegain({ scripts: [meetingScript()] }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { cfg, session } = setup(vg, ol);
  session.title = 'Budget sync'; session.addPerson('Priya'); session.addPerson('Anil');
  const seenLive = []; session.on('transcript', () => seenLive.push(session.lines().length));
  await session.start();
  await waitFor(() => session.clockSec() >= 0.4); session.setSpeaker('Priya');
  await waitFor(() => session.clockSec() >= 3.3); await runCommand(session, '/a Book the venue');
  await waitFor(() => session.clockSec() >= 4.3); await runCommand(session, '/speaker Anil');
  await waitFor(() => session.clockSec() >= 6.5); await runCommand(session, '/d Ship the Q3 plan in November'); await runCommand(session, 'Budget looks tight');
  const r = await finish(session);

  assert.match(path.basename(r.dir), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
  assert.deepEqual(fs.readdirSync(r.dir).filter((f) => !f.startsWith('.')).sort(), ['personal-notes.md', 'summary.md', 'transcript.md']);
  assert.ok(seenLive.length > 3, 'transcript events arrived while the meeting ran');

  const tr = fs.readFileSync(r.files.transcript, 'utf8');
  assert.match(tr, /\*\*\[00:00\] Priya:\*\* Hello everyone welcome\./);   // wordEdit applied, punctuation joined
  assert.doesNotMatch(tr, /welcomme/);
  assert.match(tr, /\*\*\[00:02\] Rishabh:\*\* Thanks for having me/);       // mic channel = me
  assert.match(tr, /\*\*\[00:04\] Anil:\*\* Let's review the Q3 budget Anil will send the deck by Friday/); // timeline switch
  const notes = fs.readFileSync(r.files.notes, 'utf8');
  assert.match(notes, /- \[ \] `0[0-9]:[0-9]{2}` \*\*Action:\*\* Book the venue/); assert.match(notes, /\*\*Decision:\*\* Ship the Q3 plan in November/); assert.match(notes, /Budget looks tight/);
  const sum = fs.readFileSync(r.files.summary, 'utf8');
  assert.match(sum, /^# Budget sync/); assert.match(sum, /Participants:\*\* Rishabh, Priya, Anil/); assert.match(sum, /The team reviewed the Q3 budget\./);
  assert.match(sum, /\*\*Anil\*\*: send the deck/); assert.match(sum, /\*\*Decision:\*\* Ship the Q3 plan in November/);
  assert.match(sum, /- \[ \] \*\*Rishabh\*\*: Book the venue/);            // your /a note is guaranteed into the action items
  assert.doesNotMatch(sum, /None recorded\.\n- Ship/);                         // placeholder replaced when your /d note is added

  // what went to the local model: transcript with speaker names + your notes tagged, nothing else needed
  assert.equal(ol.requests.length, 1);
  const prompt = ol.requests[0].messages[1].content;
  assert.match(prompt, /Anil: Let's review/); assert.match(prompt, /MY NOTE \[ACTION ITEM\]: Book the venue/); assert.match(prompt, /MY NOTE: Budget looks tight/);
  assert.equal(ol.requests[0].options.num_ctx, 16384);

  // what went to Voicegain
  const req = vg.state.requests[0];
  assert.equal(req.audio.channels, 'stereo'); assert.equal(req.audio.format, 'L16'); assert.equal(req.speakerChannels.length, 2);
  assert.ok(req.asr.hints.includes('Priya:6') && req.asr.hints.includes('Rishabh:6')); assert.equal(req.label, 'Budget sync');
  const s0 = vg.state.sessions[0]; assert.ok(s0.bytes >= 9 * 64000 * 0.97, `audio bytes ${s0.bytes}`); assert.equal(s0.bytes, session.bytes);

  // recovery data: rebuild identical transcript, then re-summarize with another template
  for (const f of ['ws.jsonl', 'notes.jsonl', 'events.jsonl', 'meeting.json']) assert.ok(fs.existsSync(path.join(r.dir, '.data', f)), f);
  const m = loadMeeting(r.dir, cfg);
  assert.deepEqual(m.lines.map((l) => `${l.speaker}|${l.text}`), session.lines().map((l) => `${l.speaker}|${l.text}`));
  assert.equal(m.notes.length, 3);
  const rs = await resummarize(r.dir, cfg, { template: 'one-on-one' });
  assert.equal(rs.template, 'one-on-one'); assert.ok(fs.existsSync(path.join(r.dir, 'summary.previous.md')));
  assert.match(fs.readFileSync(path.join(r.dir, 'summary.md'), 'utf8'), /## Check-in\nGenerated checkin/);
});

test('connection drop mid-meeting: reconnects, new session gets the right time offset, nothing lost', async (t) => {
  const second = [{ atMs: 0, payload: SPEAKERS }, { atMs: 300, payload: { word: [{ utt: 'After', start: 100, end: 300, spk: 2 }, { utt: 'reconnect', start: 350, end: 800, spk: 2 }] } }];
  const first = [{ atMs: 0, payload: SPEAKERS }, { atMs: 400, payload: { word: [{ utt: 'Before', start: 100, end: 300, spk: 2 }, { utt: 'drop', start: 350, end: 700, spk: 2 }] } }];
  const vg = await startMockVoicegain({ scripts: [first, second], dropAtMs: { 0: 2000 } }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol);
  const logs = []; session.on('log', (l) => logs.push(l.text));
  await session.start();
  const r = await finish(session);
  assert.equal(vg.state.sessions.length, 2, 'a second Voicegain session was opened');
  assert.ok(logs.some((t) => /connection lost/.test(t)));
  const lines = session.lines();
  assert.deepEqual(lines.map((l) => l.text), ['Before drop', 'After reconnect']);
  const offsetMs = vg.state.sessions[0].bytes / 64;               // audio the first session consumed before dropping
  assert.ok(lines[1].t > 2.0 && Math.abs(lines[1].t - (offsetMs / 1000 + 0.1)) < 1.5, `second line at ${lines[1].t}s`);
  assert.ok(vg.state.sessions[1].bytes > 3 * 64000, 'buffered + live audio was flushed to the new session');
  assert.match(fs.readFileSync(r.files.transcript, 'utf8'), /Before drop[\s\S]*After reconnect/);
});

test('pause/resume: no audio is counted or sent while paused; same session continues', async (t) => {
  const vg = await startMockVoicegain({ scripts: [meetingScript()] }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol);
  await session.start();
  await waitFor(() => session.clockSec() >= 2); assert.equal(session.pause(), true); const at = session.clockSec();
  await new Promise((r) => setTimeout(r, 120)); assert.equal(session.clockSec(), at); assert.equal(session.state, 'paused');
  assert.equal(session.resume(), true);
  await finish(session);
  assert.ok(session.clockSec() < 8.6 && session.clockSec() > 5, `clock ${session.clockSec()}`);
  assert.equal(vg.state.sessions.length, 1); assert.equal(vg.state.sessions[0].bytes, session.bytes);
});

test('bad JWT: meeting still records notes and writes all three files; no retry storm', async (t) => {
  const vg = await startMockVoicegain({ scripts: [[]], jwt: 'right' }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol, { jwt: 'wrong-token-value' });
  const errs = []; session.on('log', (l) => l.level === 'error' && errs.push(l.text));
  await session.start(); session.addNote('note', 'still taking notes');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(session.linkState, 'failed');
  const r = await finish(session);
  assert.equal(vg.state.unauthorized, 1); assert.ok(errs.some((e) => /401/.test(e) && /expired/.test(e)) && errs.some((e) => /\/reconnect/.test(e)));
  assert.ok(errs.every((e) => !e.includes('wrong-token-value')));
  assert.match(fs.readFileSync(r.files.notes, 'utf8'), /still taking notes/);
  assert.match(fs.readFileSync(r.files.transcript, 'utf8'), /No speech was transcribed/);
  assert.equal(ol.requests.length, 1); assert.match(ol.requests[0].messages[1].content, /MY NOTE: still taking notes/);   // notes alone are still summarized
});

test('Ollama down: transcript + notes saved, summary.md explains and keeps your notes', async (t) => {
  const vg = await startMockVoicegain({ scripts: [meetingScript()] }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session, cfg } = setup(vg, ol); cfg.llm.url = 'http://127.0.0.1:9';
  await session.start(); await runCommand(session, '/q Who owns QA?');
  const r = await finish(session);
  const sum = fs.readFileSync(r.files.summary, 'utf8');
  assert.match(sum, /Summary not generated/); assert.match(sum, /Ollama/); assert.match(sum, /Who owns QA\?/);
  assert.match(r.warning, /Ollama/); assert.match(fs.readFileSync(r.files.transcript, 'utf8'), /Hello everyone welcome\./);
});

test('diarization requested but rejected by the API: falls back automatically with a warning', async (t) => {
  const vg = await startMockVoicegain({ scripts: [meetingScript()], rejectDiarization: true }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol, { diarization: true });
  const logs = []; session.on('log', (l) => logs.push(l.text));
  await session.start(); await finish(session);
  assert.equal(vg.state.requests.length, 2); assert.ok(vg.state.requests[0].asr.diarization); assert.equal(vg.state.requests[1].asr.diarization, undefined);
  assert.ok(logs.some((t) => /rejected diarization/.test(t)));
});

test('Voicegain diarized speakers: labels come from the API and /name renames them', async (t) => {
  const script = [{ atMs: 0, payload: { speaker: [{ spk: 1, chn: 0, agent: true }, { spk: 2, chn: 1, diarized: true }, { spk: 3, chn: 1, diarized: true }] } },
    { atMs: 500, payload: { word: [{ utt: 'First', start: 100, end: 300, spk: 2 }, { utt: 'voice', start: 350, end: 600, spk: 2 }, { utt: 'Second', start: 2500, end: 2800, spk: 3 }, { utt: 'voice', start: 2850, end: 3100, spk: 3 }] } }];
  const vg = await startMockVoicegain({ scripts: [script] }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol);
  await session.start(); await runCommand(session, '/name Speaker 3 Mira');
  await finish(session);
  assert.deepEqual(session.lines().map((l) => l.speaker), ['Speaker 2', 'Mira']);
});

test('/relabel fixes the last remote line and everything after it', async (t) => {
  const vg = await startMockVoicegain({ scripts: [meetingScript()] }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol); session.addPerson('Priya'); session.addPerson('Anil');
  await session.start(); await waitFor(() => session.lines().some((l) => /Friday/.test(l.text)));
  const out = await runCommand(session, '/relabel Anil'); assert.match(out[0].text, /Anil/);
  await finish(session);
  const sp = session.lines().map((l) => l.speaker);
  assert.equal(sp.at(-1), 'Anil'); assert.equal(sp[1], 'Rishabh');
});

test('slash commands: roster, speaker, presets, ics, template, title, errors', async (t) => {
  process.env.MEETBOT_HOME = tmp('home-');
  const vg = await startMockVoicegain({}); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const { session } = setup(vg, ol);
  const say = async (l) => (await runCommand(session, l)).map((m) => m.text).join('\n');
  assert.match(await say('/add Priya, Anil'), /Added: Priya, Anil/); assert.match(await say('/roster'), /1\. Priya[\s\S]*2\. Anil/);
  assert.match(await say('/speaker 2'), /Speaker: Anil/); assert.match(await say('/speaker 9'), /Unknown participant/);
  assert.match(await say('/rm 1'), /Removed Priya/);
  assert.match(await say('/preset save team'), /Saved preset "team"/); assert.match(await say('/preset list'), /team/);
  await say('/rm Anil'); assert.deepEqual(session.book.roster, []);
  assert.match(await say('/preset load team'), /Loaded preset "team"/); assert.deepEqual(session.book.roster, ['Anil']);
  const ics = path.join(tmp(), 'i.ics'); fs.writeFileSync(ics, 'BEGIN:VEVENT\nSUMMARY:Design review\nATTENDEE;CN=Sam Lee:mailto:s@x.com\nATTENDEE;CN=Rishabh:mailto:r@x.com\nEND:VEVENT\n');
  assert.match(await say(`/ics ${ics}`), /Loaded "Design review" with 2 attendees/); assert.equal(session.title, 'Design review'); assert.deepEqual(session.book.roster, ['Anil', 'Sam Lee']);
  assert.match(await say('/template standup'), /standup/); assert.match(await say('/template nope'), /not found/);
  assert.match(await say('/title Ship it'), /Title set/); assert.equal(session.title, 'Ship it');
  assert.match(await say('/mode room'), /room/); assert.match(await say('/nonsense'), /Unknown command/); assert.match(await say('/pause'), /Not recording/);
  assert.match(await say('/hint Kubernetes, Kafka'), /Kubernetes, Kafka/);
  assert.equal(await say('/q'), 'Usage: /q <text>'.replace('/q', '/q')); assert.deepEqual(session.notes, []);
});

test('CLI plain mode end to end (spawned process, mock servers, WAV replay)', async (t) => {
  const vg = await startMockVoicegain({ scripts: [meetingScript()] }); const ol = await startMockOllama(); t.after(() => Promise.all([vg.close(), ol.close()]));
  const out = tmp('cli-out-'); const wav = wavFile();
  const env = { ...process.env, VOICEGAIN_JWT: vg.jwt, VOICEGAIN_SA_CONFIG: vg.saConfig, VOICEGAIN_BASE_URL: vg.baseUrl, OLLAMA_URL: ol.url, MEETBOT_HOME: tmp('home-') };
  const p = spawn(process.execPath, ['bin/meetbot.js', '--plain', '--file', wav, '--speed', '10', '--out', out, '--title', 'CLI test', '--attendee', 'Priya'], { env, cwd: path.resolve('.') });
  let stdout = ''; p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stdout += d; });
  setTimeout(() => p.stdin.write('typed from the terminal\n/a follow up\n'), 800);
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 0, stdout);
  const dir = path.join(out, fs.readdirSync(out)[0]);
  assert.match(fs.readFileSync(path.join(dir, 'personal-notes.md'), 'utf8'), /typed from the terminal/);
  assert.match(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), /Hello everyone welcome\./);
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /^# CLI test/);
  assert.match(stdout, /Hello everyone welcome\./); assert.match(stdout, /Saved to /);
});
