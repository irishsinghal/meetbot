// Local web UI: a tiny http + websocket server bound to 127.0.0.1 that mirrors a MeetingSession to a browser page
// and feeds typed lines back through the shared slash-command parser (src/commands.js).
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { HELP, runCommand } from '../commands.js';
import { KINDS } from '../notes.js';
import { writeLog } from '../errlog.js';

const PAGE = new URL('./index.html', import.meta.url);
const EVENTS = ['state', 'transcript', 'notes', 'levels', 'speakers', 'link', 'log', 'progress', 'done'];

/** Merge consecutive lines of one speaker (gap <= 4 s) into turns. */
export function toTurns(lines) {
  const turns = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === l.speaker && l.t - last.tEnd <= 4) { last.tEnd = l.tEnd; last.text += ` ${l.text}`; last.live = l.live; } else turns.push({ t: l.t, tEnd: l.tEnd, speaker: l.speaker, text: l.text, live: l.live });
  }
  return turns;
}

export function snapshot(session, { withTranscript = true } = {}) {
  const lastLog = session.logs.at(-1);
  const s = {
    remote: session.book.roster.length > 0 || session.lines().some((l) => l.speaker !== session.book.me), state: session.state, record: !!session.recordAudio, clock: session.clockSec(), title: session.title || '', link: session.linkState,
    levels: session.levels, me: session.book.me, mode: session.book.mode, current: session.book.current, roster: session.book.roster,
    notes: session.notes.map((n) => ({ t: n.t, kind: n.kind, label: KINDS[n.kind], text: n.text })),
    log: lastLog ? { level: lastLog.level, text: lastLog.text, at: lastLog.at } : null, progress: session.progressText || '',
    finalizing: !!session.finalizing, result: session.result ? { draft: !!session.result.draft, dir: session.result.dir, warning: session.result.warning, summary: session.result.summaryText, lines: session.result.lines, durationSec: session.result.durationSec } : null,
  };
  if (withTranscript) s.turns = toTurns(session.lines());
  return s;
}

const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

/** A Chromium-based browser that can open a chromeless "app" window (no tabs / address bar), or null. */
export function findAppBrowser(env = process.env, platform = process.platform) {
  const c = [];
  if (platform === 'win32') {
    for (const base of [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA]) {
      if (!base) continue;
      c.push(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (platform === 'darwin') {
    c.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  } else {
    for (const d of (env.PATH || '').split(':')) for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) c.push(`${d}/${n}`);
  }
  return c.find(exists) || null;
}

/** Open the UI: as a small popup window when a Chromium browser is installed (popup=true), else in the default browser. */
export function openBrowser(url, { popup = true } = {}) {
  try {
    const exe = popup ? findAppBrowser() : null;
    if (exe) { spawn(exe, [`--app=${url}`, '--window-size=420,820'], { detached: true, stdio: 'ignore' }).unref(); return 'popup'; }
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref(); return 'tab';
  } catch { return false; }
}

/** Start the UI. Resolves {url, close, finished} once listening; `finished` resolves when the browser sends "quit". */
export async function startWebUi(session, { port = 0, open = true, popup = true, autoStart = false } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const html = fs.readFileSync(PAGE, 'utf8').replace('__HELP__', JSON.stringify(HELP).replace(/</g, '\u003c'));
  let quit; const finished = new Promise((r) => { quit = r; });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname !== '/' || u.searchParams.get('t') !== token) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url, 'http://x'); const origin = req.headers.origin;
    const okOrigin = !origin || new URL(origin).host === req.headers.host; // block other web pages from driving the session
    if (u.pathname !== '/ws' || u.searchParams.get('t') !== token || !okOrigin) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
  });

  session.richUi = true; // /catchup results go to the page as a card instead of the status line
  const broadcast = (o) => { const data = JSON.stringify(o); for (const c of wss.clients) if (c.readyState === 1) c.send(data); };
  const onCatchup = (r) => broadcast({ type: 'catchup', summary: r.summary, asked: r.asked, topic: r.topic, from: r.from, to: r.to, fallback: r.fallback || '' });
  const onMention = (m) => broadcast({ type: 'mention', ...m });
  session.on('catchup', onCatchup); session.on('mention', onMention);

  let lastVersion = ''; let timer = null;
  const push = (force = false) => {
    timer = null; if (!wss.clients.size) return;
    const full = snapshot(session);
    const v = JSON.stringify(full.turns);
    const msg = { type: 'state', ...full };
    if (!force && v === lastVersion) delete msg.turns; else lastVersion = v;
    const data = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };
  const kick = () => { if (!timer) timer = setTimeout(push, 120); };
  EVENTS.forEach((e) => session.on(e, kick));
  const tick = setInterval(kick, 1000);

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', ...snapshot(session) }));
    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (m.type === 'line' && typeof m.line === 'string') {
          const out = await runCommand(session, m.line.slice(0, 4000));
          ws.send(JSON.stringify({ type: 'reply', messages: out }));
        } else if (m.type === 'speaker' && typeof m.name === 'string') session.setSpeaker(m.name);
        else if (m.type === 'quit') quit();
      } catch (e) { writeLog('error', `web command failed: ${e?.stack || e}`); ws.send(JSON.stringify({ type: 'reply', messages: [{ text: `Error: ${e.message}`, level: 'error' }] })); }
      kick();
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  writeLog('info', `web UI listening on ${url.replace(token, '<token>')}`);
  if (autoStart) runCommand(session, '/start').catch(() => {});
  if (open) openBrowser(url, { popup });
  const close = () => { clearInterval(tick); session.off('catchup', onCatchup); session.off('mention', onMention); session.richUi = false; EVENTS.forEach((e) => session.off(e, kick)); for (const c of wss.clients) c.terminate(); server.close(); };
  return { url, close, finished };
}
