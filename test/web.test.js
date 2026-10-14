import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { startWebUi, toTurns } from '../src/web/server.js';

const fakeSession = () => Object.assign(new EventEmitter(), {
  state: 'ready', title: 't', linkState: 'idle', levels: { mic: 0, sys: 0 }, logs: [], notes: [], result: null, progressText: '',
  book: { me: 'You', mode: 'call', current: null, roster: [] }, clockSec: () => 1, lines: () => [], addNoteLine(l) { this.notes.push({ t: 1, kind: 'note', text: l }); return true; },
});

test('toTurns merges nearby lines of one speaker', () => {
  const t = toTurns([{ t: 0, tEnd: 2, speaker: 'A', text: 'hi' }, { t: 3, tEnd: 4, speaker: 'A', text: 'there' }, { t: 5, tEnd: 6, speaker: 'B', text: 'yo' }]);
  assert.deepEqual(t.map((x) => x.text), ['hi there', 'yo']);
});

test('web UI: needs the token, streams state, runs typed notes', async () => {
  const s = fakeSession();
  const ui = await startWebUi(s, { open: false });
  try {
    const u = new URL(ui.url);
    assert.equal((await fetch(`http://127.0.0.1:${u.port}/`)).status, 404);
    assert.equal((await fetch(ui.url)).status, 200);
    const ws = new WebSocket(`ws://127.0.0.1:${u.port}/ws${u.search}`);
    const msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'line', line: 'hello note' }));
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(msgs[0].type, 'state'); assert.equal(msgs[0].state, 'ready');
    assert.equal(s.notes[0].text, 'hello note');
    const bad = new WebSocket(`ws://127.0.0.1:${u.port}/ws?t=wrong`);
    await new Promise((r) => bad.on('error', r));
    ws.close();
  } finally { ui.close(); }
});
