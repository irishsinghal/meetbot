import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePayload } from '../src/voicegain/parse.js';
import { TranscriptBuilder } from '../src/voicegain/transcript.js';
import { buildSessionRequest, createSession, toHints } from '../src/voicegain/client.js';
import { SpeakerBook, PresetStore } from '../src/speakers.js';
import { parseNoteLine } from '../src/notes.js';
import { parseIcs } from '../src/ics.js';
import { parseSlots, fillTemplate } from '../src/summarize/template.js';
import { ensureNoteItems, similar, chunkRows } from '../src/summarize/index.js';
import { renderTranscript, renderPersonalNotes, fmtClock, toTurns } from '../src/render.js';
import { parseWav, writeWav, toStereo16k, stereoLevels } from '../src/audio/wav.js';
import { defaults, redact } from '../src/config.js';
import { wrap, transcriptRows } from '../src/tui/app.js';

const cfg = () => { const c = defaults(); c.voicegain.jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig-sig-sig'; c.voicegain.saConfig = 'cfg-1'; return c; };
const W = (utt, start, end, spk) => ({ utt, start, end, spk });

test('parsePayload: speakers, words, edits, segments, analytics', () => {
  const p = parsePayload({ speaker: [{ spk: 1, agent: true, chn: 0, diarized: false }], word: [W('hi', 0, 100, 1)],
    wordEdit: [{ del: 2, spk: 1, words: [W('yo', 0, 50)] }], segment: [{ type: 'recognition', time: 1000, duration: 500, spk: 2, alternatives: [{ text: 'Hi there', confidence: 0.8 }] }],
    keyword: [{ tag: 'X', phrase: 'y', start: 1, end: 2 }] });
  assert.deepEqual(p.speakers[0], { spk: 1, chn: 0, agent: true, diarized: false });
  assert.equal(p.words[0].text, 'hi'); assert.equal(p.edits[0].del, 2); assert.equal(p.edits[0].words[0].text, 'yo');
  assert.deepEqual([p.segments[0].final, p.segments[0].start, p.segments[0].end, p.segments[0].text], [true, 1000, 1500, 'Hi there']);
  assert.ok(p.analytics.keyword);
  assert.equal(parsePayload(null), null); assert.equal(parsePayload([]), null);
  assert.deepEqual(parsePayload({}).words, []);
});

test('TranscriptBuilder: lines by gap, punctuation joins, wordEdit replaces, speakers kept apart', () => {
  const b = new TranscriptBuilder({ lineGapMs: 1000 });
  b.ingest({ speaker: [{ spk: 1, chn: 0 }, { spk: 2, chn: 1 }] });
  b.ingest({ word: [W('Helo', 0, 300, 2), W('world', 350, 700, 2)] });
  b.ingest({ word: [W('Hi', 400, 600, 1)] });
  b.ingest({ wordEdit: [{ del: 2, spk: 2, words: [W('Hello', 0, 300, 2), W('world', 350, 700, 2), W('.', 700, 700, 2)] }] });
  b.ingest({ word: [W('Next', 5000, 5300, 2), W('line', 5350, 5600, 2)] });
  const lines = b.lines(10000);
  assert.deepEqual(lines.map((l) => [l.chn, l.text]), [[1, 'Hello world.'], [0, 'Hi'], [1, 'Next line']]);
  assert.equal(lines[0].live, false);
  assert.equal(b.lines(5700)[2].live, true);
});

test('TranscriptBuilder: session offsets (reconnect) keep one timeline; speakers re-keyed per session', () => {
  const b = new TranscriptBuilder();
  b.ingest({ speaker: [{ spk: 1, chn: 1 }] }); b.ingest({ word: [W('one', 100, 300, 1)] });
  b.beginSession(60000);
  b.ingest({ speaker: [{ spk: 1, chn: 1 }] }); b.ingest({ word: [W('two', 100, 300, 1)] });
  const l = b.lines(1e9);
  assert.deepEqual(l.map((x) => [x.text, x.tStart]), [['one', 100], ['two', 60100]]);
  assert.notEqual(l[0].skey, l[1].skey);
});

test('TranscriptBuilder: segments mode (hypothesis replaced, recognition final)', () => {
  const b = new TranscriptBuilder();
  b.ingest({ segment: [{ type: 'hypothesis', time: 0, duration: 800, spk: 1, alternatives: [{ text: 'hello th' }] }] });
  assert.equal(b.lines(0)[0].text, 'hello th'); assert.equal(b.lines(0)[0].live, true);
  b.ingest({ segment: [{ type: 'hypothesis', time: 0, duration: 1000, spk: 1, alternatives: [{ text: 'hello there' }] }] });
  assert.equal(b.lines(0).length, 1);
  b.ingest({ segment: [{ type: 'recognition', time: 0, duration: 1200, spk: 1, alternatives: [{ text: 'Hello there.' }] }] });
  const l = b.lines(1e9); assert.equal(l.length, 1); assert.equal(l[0].text, 'Hello there.');
});

test('buildSessionRequest follows the /sa schema: stereo L16 16k, left=mic right=system, hints, saConfig', () => {
  const c = cfg();
  const r = buildSessionRequest(c, { title: 'Weekly: sync/1', hints: ['Priya Shah', 'Kubernetes', 'kubernetes', 'R&D'] });
  assert.equal(r.saConfig, 'cfg-1'); assert.equal(r.label, 'Weekly sync1');
  assert.deepEqual(r.audio, { source: { stream: { protocol: 'WSS', noAudioTimeout: 1800000 } }, format: 'L16', rate: 16000, channels: 'stereo', capture: false });
  assert.deepEqual(r.speakerChannels.map((x) => x.audioChannelSelector), ['left', 'right']);
  assert.equal(r.virtualDualChannelEnabled, false);
  assert.deepEqual(r.asr.hints, ['Priya_Shah:6', 'Kubernetes:6', 'RD:6']);
  assert.equal(r.asr.content, 'segments'); assert.deepEqual(r.asr.languages, ['en-us']); assert.equal(r.asr.diarization, undefined);
  c.voicegain.diarization = true; c.voicegain.maxSpeakers = 4;
  assert.deepEqual(buildSessionRequest(c).asr.diarization, { minSpeakers: 1, maxSpeakers: 4 });
  assert.equal(toHints(Array.from({ length: 80 }, (_, i) => `w${i}`)).length, 50);
});

test('createSession: errors are explained and never leak the JWT', async () => {
  const c = cfg();
  const mk = (status, body) => async () => ({ ok: status < 300, status, statusText: 'x', text: async () => JSON.stringify(body) });
  await assert.rejects(createSession(c, {}, mk(401, { error: { reason: 'JWT error', detail: `bad ${c.voicegain.jwt}` } })), (e) => /expired/.test(e.message) && !e.message.includes(c.voicegain.jwt) && e.status === 401);
  c.voicegain.saConfig = '';
  await assert.rejects(createSession(c, {}, mk(400, { error: { reason: 'Missing resource', detail: 'saConfig' } })), /VOICEGAIN_SA_CONFIG/);
  c.voicegain.jwt = '';
  await assert.rejects(createSession(c, {}, mk(200, {})), /VOICEGAIN_JWT/);
  c.voicegain.jwt = 'secret-token-123';
  await assert.rejects(createSession(c, {}, mk(200, { saSessionId: 'x' })), /missing websocket URLs/);
  const ok = await createSession(c, {}, mk(200, { saSessionId: 's', audio: { stream: { websocketUrl: 'wss:/h/a' } }, websocket: { url: 'wss://h/r' } }));
  assert.equal(ok.audioUrl, 'wss://h/a');
  assert.equal(redact(`token ${'eyJabcdefghijk.lmnopqrstuvwxyz.abcd'}`, c), 'token <JWT>');
});

test('SpeakerBook: roster, lookup, timeline attribution, cycling, rename, modes', () => {
  const b = new SpeakerBook({ me: 'Rishabh', roster: ['Priya', 'Anil', 'Sam'] });
  assert.equal(b.lookup('2'), 'Anil'); assert.equal(b.lookup('pri'), 'Priya'); assert.equal(b.lookup('zed'), null); assert.equal(b.lookup('9'), null);
  assert.equal(b.setCurrent('1', 0), 'Priya'); b.setCurrent('Anil', 10); b.setCurrent('Dev', 20);
  assert.ok(b.roster.includes('Dev'));
  const L = (id, chn, t, extra = {}) => ({ id, chn, tStart: t * 1000, spk: 2, diarized: false, ...extra });
  assert.equal(b.displayFor(L('a', 0, 5)), 'Rishabh');
  assert.deepEqual([5, 12, 25].map((t) => b.displayFor(L('x', 1, t))), ['Priya', 'Anil', 'Dev']);
  assert.equal(b.displayFor(L('y', 1, 5, { diarized: true, spk: 3 })), 'Speaker 3');
  b.rename('Speaker 3', 'Mira'); assert.equal(b.displayFor(L('y', 1, 5, { diarized: true, spk: 3 })), 'Mira');
  b.overrides.set('a', 'Sam'); assert.equal(b.displayFor(L('a', 0, 5)), 'Sam');
  b.setCurrent('Anil', 8); assert.equal(b.speakerAt(30), 'Anil'); // newer decision supersedes later timeline entries
  const c = new SpeakerBook({ roster: ['A', 'B'] }); assert.equal(c.cycle(1, 0), 'A'); assert.equal(c.cycle(1, 1), 'B'); assert.equal(c.cycle(1, 2), 'A'); assert.equal(c.cycle(-1, 3), 'B');
  c.mode = 'room'; assert.equal(c.displayFor(L('r', 0, 0)), 'A');
  assert.equal(c.remove('A'), 'A'); assert.deepEqual(c.roster, ['B']);
});

test('PresetStore saves/loads/lists/removes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-')); const s = new PresetStore(dir);
  const b = new SpeakerBook({ me: 'Me', roster: ['A', 'B'], mode: 'room' });
  s.save('team sync', b, { hints: ['Kafka'] });
  assert.deepEqual(s.list(), ['team_sync']);
  assert.deepEqual(s.load('team sync'), { me: 'Me', mode: 'room', participants: ['A', 'B'], hints: ['Kafka'] });
  assert.equal(s.load('nope'), null); assert.equal(s.remove('team sync'), true); assert.deepEqual(s.list(), []);
});

test('note lines', () => {
  assert.deepEqual(parseNoteLine('hello'), { kind: 'note', text: 'hello' });
  assert.deepEqual(parseNoteLine('/a send deck'), { kind: 'action', text: 'send deck' });
  assert.deepEqual(parseNoteLine('/todo x'), { kind: 'action', text: 'x' });
  assert.deepEqual(parseNoteLine('/f'), { kind: 'flag', text: 'Important moment' });
  assert.equal(parseNoteLine('/a'), null); assert.equal(parseNoteLine('/speaker 2'), null); assert.equal(parseNoteLine('  '), null);
});

test('ICS invite -> title, start, attendees (folded lines, CN names, email fallback, dedupe)', () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Q3 planning\\, final', 'DTSTART:20261014T093000Z', 'ORGANIZER;CN="Dana Lee":mailto:dana@x.com',
    'ATTENDEE;CN=Priya Shah;ROLE=REQ-PARTICIPANT:mailto:priya@x.com', 'ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:anil.kumar@x.com', 'ATTENDEE;CN=Priya',
    '  Shah:mailto:priya@x.com', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const ev = parseIcs(ics);
  assert.equal(ev.title, 'Q3 planning, final'); assert.equal(ev.start.toISOString(), '2026-10-14T09:30:00.000Z');
  assert.deepEqual(ev.attendees.map((a) => a.name), ['Dana Lee', 'Priya Shah', 'Anil Kumar']);
});

test('templates: slots parsed, builtins and AI sections filled, unknown placeholders untouched', () => {
  const t = '# {{title}}\n{{ai:summary|short}}\n{{ai:summary|again}}\n{{ai:actions}}\n{{personal_notes}} {{weird}}';
  assert.deepEqual(parseSlots(t), [{ key: 'summary', instruction: 'short' }, { key: 'actions', instruction: 'Write this section concisely.' }]);
  const out = fillTemplate(t, { title: 'T', personal_notes: 'N' }, { summary: 'S' });
  assert.equal(out, '# T\nS\nS\n_Not generated._\nN {{weird}}\n');
});

test('ensureNoteItems appends flagged items the model skipped, keeps paraphrased ones', () => {
  const notes = [{ kind: 'action', text: 'Send deck to Priya' }, { kind: 'action', text: 'Book the venue' }, { kind: 'decision', text: 'Ship in November' }, { kind: 'question', text: 'Who owns QA?' }];
  const ai = { actions: '- [ ] **Priya**: send the deck', decisions: 'None recorded.', questions: '- Who owns QA?' };
  ensureNoteItems(ai, notes, 'Rishabh');
  assert.equal(ai.actions, '- [ ] **Priya**: send the deck\n- [ ] **Rishabh**: Book the venue');
  assert.equal(ai.decisions, '- Ship in November'); assert.equal(ai.questions, '- Who owns QA?');
  assert.ok(similar('Send deck', 'we will send the deck friday'));
  assert.equal(chunkRows(['aaaa', 'bbbb', 'cccc'], 9).length, 2);
});

test('render: transcript turns merge, personal notes list', () => {
  assert.equal(fmtClock(75), '01:15'); assert.equal(fmtClock(3725), '1:02:05');
  const lines = [{ t: 0, tEnd: 2, speaker: 'A', text: 'Hi' }, { t: 3, tEnd: 4, speaker: 'A', text: 'there' }, { t: 20, tEnd: 21, speaker: 'B', text: 'Yo' }];
  assert.equal(toTurns(lines).length, 2);
  const md = renderTranscript({ title: 'T', startedAt: new Date(2026, 9, 14, 9, 5), durationSec: 90, participants: ['A', 'B'], lines });
  assert.match(md, /\*\*\[00:00\] A:\*\* Hi there/); assert.match(md, /\*\*Started:\*\* 2026-10-14 09:05/);
  const n = renderPersonalNotes({ title: 'T', startedAt: new Date(2026, 9, 14, 9, 5), notes: [{ t: 5, kind: 'action', text: 'x' }, { t: 9, kind: 'note', text: 'y' }] });
  assert.match(n, /- \[ \] `00:05` \*\*Action:\*\* x/); assert.match(n, /- `00:09` y/);
});

test('wav: write/parse roundtrip, resample to stereo 16k, channel placement, levels', () => {
  const mono = new Int16Array(8000).fill(10000);
  const wav = parseWav(writeWav({ channels: 1, rate: 8000, samples: mono }));
  const sys = new Int16Array(toStereo16k(wav, 'system').buffer.slice(0)); assert.equal(sys.length, 16000 * 2);
  assert.equal(sys[100], 0); assert.ok(sys[101] > 9000);               // right channel only
  const mic = new Int16Array(toStereo16k(wav, 'mic').buffer.slice(0)); assert.ok(mic[100] > 9000 && mic[101] === 0);
  const lv = stereoLevels(Buffer.from(toStereo16k(wav, 'system'))); assert.ok(lv.sys > 0.2 && lv.mic === 0);
  assert.throws(() => parseWav(Buffer.from('nope')), /Not a WAV/);
});

test('tui helpers: wrap and transcript rows', () => {
  assert.deepEqual(wrap('aaa bbb ccc', 7), ['aaa bbb', 'ccc']); assert.deepEqual(wrap('x'.repeat(10), 4), ['xxxx', 'xxxx', 'xx']);
  const rows = transcriptRows([{ t: 0, tEnd: 1, speaker: 'You', text: 'hello', live: false }, { t: 2, tEnd: 3, speaker: 'You', text: 'again', live: true }], 40, 'You');
  assert.equal(rows[0].prefix, '00:00 You: '); assert.equal(rows[0].text, 'hello again'); assert.equal(rows[0].dim, true);
});

test('saveConfig merges into an existing config.json', async () => {
  const { saveConfig } = await import('../src/setup.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-setup-'));
  saveConfig({ me: 'A', voicegain: { saConfig: 'x' } }, dir);
  saveConfig({ voicegain: { jwt: 'j' } }, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { me: 'A', voicegain: { saConfig: 'x', jwt: 'j' } });
});

test('folder layouts and migration between them', async () => {
  const { MeetingFolder, planMigration, applyMigration, findMeetings } = await import('../src/storage.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-layout-'));
  const d1 = new Date(2026, 9, 14, 13, 30, 37); const d2 = new Date(2026, 9, 14, 15, 0, 0); const d3 = new Date(2026, 9, 15, 9, 5, 1);
  for (const d of [d1, d2, d3]) { const f = new MeetingFolder(root, d, 'flat'); f.writeMeta({ startedAt: d.toISOString() }); f.write('summary.md', 'x'); }
  assert.ok(fs.existsSync(path.join(root, '2026-10-14_13-30-37')));
  assert.equal(planMigration(root, 'flat').length, 0);

  assert.equal(applyMigration(root, planMigration(root, 'day')).moved, 3);
  assert.ok(fs.existsSync(path.join(root, '2026-10-14', '13-30-37', 'summary.md')));
  assert.ok(fs.existsSync(path.join(root, '2026-10-15', '09-05-01', '.data', 'meeting.json')));
  assert.equal(fs.readdirSync(root).length, 2); // flat folders are gone
  assert.equal(planMigration(root, 'day').length, 0);

  assert.equal(applyMigration(root, planMigration(root, 'nested')).moved, 3);
  assert.ok(fs.existsSync(path.join(root, '2026', '10', '14', '15-00-00', 'summary.md')));
  assert.deepEqual(fs.readdirSync(root), ['2026']); // emptied day folders were removed
  assert.equal(findMeetings(root).length, 3);

  assert.equal(applyMigration(root, planMigration(root, 'flat')).moved, 3);
  assert.deepEqual(fs.readdirSync(root).sort(), ['2026-10-14_13-30-37', '2026-10-14_15-00-00', '2026-10-15_09-05-01']);
  // a new meeting at an occupied time gets a suffix
  assert.ok(new MeetingFolder(root, d1, 'day').dir.endsWith(path.join('2026-10-14', '13-30-37')));
  assert.ok(new MeetingFolder(root, d1, 'flat').dir.endsWith('_2'));
});
