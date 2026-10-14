// A stand-in for Voicegain POST /sa + the two websockets, following the OpenAPI/payload specs.
import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * scripts: array (one per session, last one reused) of [{atMs, payload}]; payloads are emitted once that much
 * audio has been received. dropAtMs (per session index): abruptly close the sockets when reached.
 */
export async function startMockVoicegain({ scripts = [[]], dropAtMs = {}, rejectDiarization = false, jwt = 'test-jwt', saConfig = 'sa-config-1' } = {}) {
  const state = { requests: [], sessions: [], unauthorized: 0 };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/sa')) { res.writeHead(404); res.end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${jwt}`) { state.unauthorized++; return send(401, { error: { reason: 'JWT error', detail: 'bad token' } }); }
      const json = JSON.parse(body); state.requests.push(json);
      if (!json.saConfig) return send(400, { error: { reason: 'Missing resource', detail: 'saConfig is required' } });
      if (rejectDiarization && json.asr?.diarization) return send(400, { error: { reason: 'Bad request', detail: 'diarization not allowed with speakerChannels' } });
      const idx = state.sessions.length; const id = `sa-${idx}`;
      const s = { idx, id, bytes: 0, sent: 0, script: scripts[Math.min(idx, scripts.length - 1)], dropAt: dropAtMs[idx], audio: null, results: null, closed: false, body: json };
      state.sessions.push(s);
      const port = server.address().port;
      send(200, { saSessionId: id, poll: { url: `http://127.0.0.1:${port}/poll/${id}` },
        speakerChannels: [{ audioChannelSelector: 'left', isAgent: true, transcribeSessionId: `t-${id}-0` }, { audioChannelSelector: 'right', transcribeSessionId: `t-${id}-1` }],
        audio: { stream: { websocketUrl: `ws://127.0.0.1:${port}/audio/${id}` } }, websocket: { url: `ws://127.0.0.1:${port}/results/${id}` } });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const [, kind, id] = req.url.split('/');
    const s = state.sessions.find((x) => x.id === id);
    if (!s) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (kind === 'results') { s.results = ws; return; }
      s.audio = ws;
      const emit = (final) => {
        const audioMs = s.bytes / 64;
        while (s.sent < s.script.length && (final || s.script[s.sent].atMs <= audioMs)) { s.results?.send(JSON.stringify(s.script[s.sent].payload)); s.sent++; }
        if (s.dropAt !== undefined && audioMs >= s.dropAt && !s.closed) { s.closed = true; s.results?.terminate(); ws.terminate(); }
      };
      ws.on('message', (data, isBinary) => { if (isBinary) { s.bytes += data.length; emit(false); } });
      ws.on('close', () => { if (!s.closed) { emit(true); s.closed = true; setTimeout(() => s.results?.close(), 30); } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, state, baseUrl: `http://127.0.0.1:${port}/v1`, jwt, saConfig, close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.close(r); }) };
}

const W = (utt, start, end, spk) => ({ utt, start, end, spk, conf: 0.9 });
export const SPEAKERS = { speaker: [{ spk: 1, agent: true, chn: 0, diarized: false }, { spk: 2, agent: false, chn: 1, diarized: false }] };

/** A realistic meeting in words mode (channel 0 = you, channel 1 = remote). Times are ms of audio. */
export function meetingScript() {
  return [
    { atMs: 0, payload: SPEAKERS },
    { atMs: 600, payload: { word: [W('Hello', 300, 600, 2), W('everyone', 650, 1000, 2), W('welcomme', 1050, 1500, 2)] } },
    { atMs: 1700, payload: { wordEdit: [{ del: 1, spk: 2, words: [W('welcome', 1050, 1500, 2), W('.', 1500, 1500, 2)] }] } },
    { atMs: 2600, payload: { word: [W('Thanks', 2200, 2500, 1), W('for', 2550, 2700, 1), W('having', 2750, 3000, 1), W('me', 3050, 3200, 1)] } },
    { atMs: 4600, payload: { word: [W("Let's", 4000, 4300, 2), W('review', 4350, 4700, 2), W('the', 4750, 4850, 2), W('Q3', 4900, 5200, 2), W('budget', 5250, 5700, 2)] } },
    { atMs: 6400, payload: { word: [W('Anil', 6000, 6300, 2), W('will', 6350, 6500, 2), W('send', 6550, 6800, 2), W('the', 6850, 6950, 2), W('deck', 7000, 7300, 2), W('by', 7350, 7500, 2), W('Friday', 7550, 8000, 2)], emotion: [{ spk: 2, start: 6000, end: 8000, sentiment: 0.4 }] } },
  ];
}
