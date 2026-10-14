// Full-screen terminal UI (Ink). Left: live transcript. Right: your notepad. Bottom: speakers, status, input.
import React, { useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import htm from 'htm';
import fs from 'node:fs';
import { HELP, runCommand } from '../commands.js';
import { KINDS } from '../notes.js';
import { fmtClock } from '../render.js';

const html = htm.bind(React.createElement);
const PALETTE = ['cyan', 'magenta', 'yellow', 'blue', 'green', 'redBright', 'cyanBright', 'magentaBright'];
const colorFor = (name, me) => {
  if (name === me) return 'greenBright';
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
};

export function wrap(text, width) {
  const out = []; let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (!word) continue;
    if (word.length > width) { if (line) { out.push(line); line = ''; } for (let i = 0; i < word.length; i += width) out.push(word.slice(i, i + width)); continue; }
    if ((line + ' ' + word).trim().length > width) { out.push(line); line = word; } else line = (line ? `${line} ` : '') + word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Turn transcript lines into display rows: [{prefix, text, color, dim}] (turns merged per speaker). */
export function transcriptRows(lines, width, me) {
  const turns = [];
  for (const l of lines) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === l.speaker && l.t - last.tEnd <= 4) { last.tEnd = l.tEnd; last.text += ` ${l.text}`; last.live = l.live; } else turns.push({ ...l });
  }
  const rows = [];
  for (const t of turns) {
    const prefix = `${fmtClock(t.t)} ${t.speaker}: `;
    const pad = ' '.repeat(Math.min(prefix.length, 12));
    const avail = Math.max(10, width - pad.length);
    const wrapped = wrap(t.text, avail);
    wrapped.forEach((w, i) => rows.push({ prefix: i === 0 ? prefix : pad, text: w, color: colorFor(t.speaker, me), dim: t.live, head: i === 0 }));
    rows.push({ prefix: '', text: '', blank: true });
  }
  return rows;
}

export function notesRows(notes, width) {
  const rows = [];
  for (const n of notes) {
    const tag = n.kind === 'note' ? '' : `${KINDS[n.kind]}: `;
    wrap(`${tag}${n.text}`, Math.max(8, width - 7)).forEach((w, i) => rows.push({ prefix: i === 0 ? `${fmtClock(n.t).padStart(5)} ` : '      ', text: w, kind: n.kind }));
  }
  return rows;
}

const bar = (v) => { const lv = Math.min(7, Math.round(Math.sqrt(v) * 14)); return '▁▂▃▄▅▆▇█'[lv]; };

function useSessionTick(session) {
  const [, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    let pending = false;
    const kick = () => { if (!pending) { pending = true; setTimeout(() => { pending = false; bump(); }, 80); } };
    const evs = ['state', 'transcript', 'notes', 'levels', 'speakers', 'link', 'log', 'progress', 'done'];
    evs.forEach((e) => session.on(e, kick));
    const iv = setInterval(kick, 1000); // keep the clock moving
    return () => { evs.forEach((e) => session.off(e, kick)); clearInterval(iv); };
  }, [session]);
}

function App({ session, autoStart, plainExit }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  const [text, setTextS] = useState(''); const [cur, setCurS] = useState(0);
  const buf = useRef({ text: '', cur: 0 }); // synchronous mirror: several keystrokes can arrive in one tick
  const setText = (t) => { buf.current.text = t; setTextS(t); };
  const setCur = (c) => { buf.current.cur = c; setCurS(c); };
  const [hist, setHist] = useState([]); const [hpos, setHpos] = useState(-1);
  const [scroll, setScroll] = useState(0); const [confirm, setConfirm] = useState(false);
  const [flash, setFlash] = useState(null); const [showHelp, setShowHelp] = useState(false);
  const flashT = useRef(null);
  useSessionTick(session);

  useEffect(() => { const on = () => setSize({ cols: stdout.columns, rows: stdout.rows }); stdout.on('resize', on); return () => stdout.off('resize', on); }, [stdout]);
  useEffect(() => { if (autoStart) runCommand(session, '/start').then((m) => m.length && say(m)); }, []);
  const say = (msgs) => { setFlash(msgs.map((m) => m.text).join('\n')); clearTimeout(flashT.current); flashT.current = setTimeout(() => setFlash(null), 6000); };

  const submit = async () => {
    const line = buf.current.text.trim(); setText(''); setCur(0); setHpos(-1);
    if (!line) { if (session.state === 'ready') say(await runCommand(session, '/start')); else if (session.state === 'done') exit(); return; }
    setHist((h) => [line, ...h].slice(0, 50));
    if (line === '/help') { setShowHelp((v) => !v); return; }
    const out = await runCommand(session, line); if (out.length) say(out);
  };

  useInput((input, key) => {
    const st = session.state;
    if (key.ctrl && input === 'c') {
      if (st === 'ready' || st === 'done') { exit(); return; }
      if (st === 'stopping') return;
      if (confirm) { setConfirm(false); runCommand(session, '/stop'); } else { setConfirm(true); setTimeout(() => setConfirm(false), 4000); }
      return;
    }
    if (confirm) setConfirm(false);
    if (st === 'done') { if (key.return || input === 'q') exit(); return; }
    if (key.ctrl && input === 'p') { runCommand(session, st === 'paused' ? '/resume' : '/pause').then(say); return; }
    if (key.ctrl && input === 'u') { setText(''); setCur(0); return; }
    if (key.ctrl && input === 'w') { const { text: t, cur: c } = buf.current; const left = t.slice(0, c).replace(/\S+\s*$/, ''); setText(left + t.slice(c)); setCur(left.length); return; }
    if (key.pageUp) { setScroll((s) => s + 5); return; }
    if (key.pageDown) { setScroll((s) => Math.max(0, s - 5)); return; }
    if (key.tab && !buf.current.text) { const n = key.shift ? session.cycleSpeaker(-1) : session.cycleSpeaker(1); if (!n) say([{ text: 'No participants. /add Name, Name or /preset load <name>' }]); return; }
    if (key.meta && /^[1-9]$/.test(input)) { const n = session.setSpeaker(input); if (!n) say([{ text: `No participant #${input}` }]); return; }
    if (key.return) { submit(); return; }
    if (input && /[\r\n]/.test(input) && !key.ctrl && !key.meta) { // text and Enter arrived in one chunk (paste / fast typing)
      const parts = input.split(/\r\n|\r|\n/);
      parts.forEach((part, i) => {
        if (part) { const { text: t, cur: c } = buf.current; setText(t.slice(0, c) + part + t.slice(c)); setCur(c + part.length); }
        if (i < parts.length - 1) submit();
      });
      return;
    }
    if (key.leftArrow) { setCur(Math.max(0, buf.current.cur - 1)); return; }
    if (key.rightArrow) { setCur(Math.min(buf.current.text.length, buf.current.cur + 1)); return; }
    if (key.upArrow) { const n = Math.min(hist.length - 1, hpos + 1); if (n >= 0) { setHpos(n); setText(hist[n]); setCur(hist[n].length); } return; }
    if (key.downArrow) { const n = hpos - 1; setHpos(n); const t = n >= 0 ? hist[n] : ''; setText(t); setCur(t.length); return; }
    if (key.backspace || key.delete) { const { text: t, cur: c } = buf.current; if (c > 0) { setText(t.slice(0, c - 1) + t.slice(c)); setCur(c - 1); } return; }
    if (input && !key.ctrl && !key.meta) { const { text: t, cur: c } = buf.current; setText(t.slice(0, c) + input + t.slice(c)); setCur(c + input.length); }
  });

  const { cols, rows } = size;
  const st = session.state;
  const me = session.book.me;
  const leftW = Math.max(30, Math.floor(cols * 0.62)); const rightW = Math.max(20, cols - leftW);
  const bodyH = Math.max(6, rows - 8);

  // ---- done screen ----
  if (st === 'done' && session.result) {
    const r = session.result;
    const preview = r.summaryText.split('\n').slice(0, Math.max(8, rows - 14)).join('\n');
    return html`<${Box} flexDirection="column" paddingX=${1}>
      <${Text} bold color="green">Meeting saved<//>
      <${Text}>${r.dir}<//>
      <${Text} dimColor>transcript.md · personal-notes.md · summary.md  (${r.lines} lines, ${fmtClock(r.durationSec)})<//>
      ${r.warning ? html`<${Text} color="yellow">${r.warning}<//>` : null}
      <${Box} marginTop=${1} borderStyle="round" paddingX=${1} flexDirection="column"><${Text}>${preview}<//><//>
      <${Text} dimColor>Enter to exit<//>
    <//>`;
  }

  const tRows = transcriptRows(session.lines(), leftW - 4, me);
  const maxScroll = Math.max(0, tRows.length - bodyH);
  const sc = Math.min(scroll, maxScroll);
  const visibleT = tRows.slice(Math.max(0, tRows.length - bodyH - sc), tRows.length - sc);
  const nRows = notesRows(session.notes, rightW - 4);
  const visibleN = nRows.slice(-bodyH);

  const stateLabel = { ready: ['READY', 'gray'], recording: ['● REC', 'red'], paused: ['❚❚ PAUSED', 'yellow'], stopping: ['… SAVING', 'cyan'] }[st] || [st, 'gray'];
  const linkColor = { connected: 'green', connecting: 'yellow', reconnecting: 'yellow', failed: 'red', idle: 'gray' }[session.linkState] || 'gray';
  const lastLog = session.logs.at(-1);
  const status = st === 'stopping' ? session.progressText : flash || (lastLog && Date.now() - lastLog.at < 15000 ? lastLog.text : '');
  const statusColor = flash ? 'white' : lastLog?.level === 'error' ? 'red' : lastLog?.level === 'warn' ? 'yellow' : 'gray';
  const roster = session.book.roster;
  const hint = st === 'ready' ? 'Press Enter to start recording' : st === 'stopping' ? 'Saving...' : 'Type a note · /a action · /d decision · /q question';
  const shown = text.length ? text : '';

  return html`<${Box} flexDirection="column" width=${cols} height=${rows - 1}>
    <${Box} justifyContent="space-between" paddingX=${1}>
      <${Text}><${Text} bold color=${stateLabel[1]}>${stateLabel[0]}<//> <${Text} bold>${fmtClock(session.clockSec())}<//>  <${Text} dimColor>${session.title || 'untitled meeting'}<//><//>
      <${Text}>mic <${Text} color="green">${bar(session.levels.mic)}<//> sys <${Text} color="cyan">${bar(session.levels.sys)}<//>  Voicegain <${Text} color=${linkColor}>${session.linkState}<//><//>
    <//>
    <${Box} height=${bodyH + 2}>
      <${Box} width=${leftW} flexDirection="column" borderStyle="round" borderColor="gray" paddingX=${1}>
        <${Text} bold>Transcript${sc ? html` <${Text} dimColor>(scrolled — PgDn to follow)<//>` : ''}<//>
        ${visibleT.map((r, i) => html`<${Text} key=${i} wrap="truncate-end"><${Text} bold=${r.head} color=${r.color} dimColor=${r.dim && !r.head}>${r.prefix}<//><${Text} dimColor=${r.dim}>${r.text}<//><//>`)}
      <//>
      <${Box} width=${rightW} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX=${1}>
        <${Text} bold color="yellow">My notes<//>
        ${visibleN.length ? visibleN.map((r, i) => html`<${Text} key=${i} wrap="truncate-end"><${Text} dimColor>${r.prefix}<//><${Text} color=${r.kind === 'action' ? 'greenBright' : r.kind === 'decision' ? 'cyanBright' : r.kind === 'question' ? 'magentaBright' : r.kind === 'flag' ? 'yellowBright' : undefined}>${r.text}<//><//>`) : html`<${Text} dimColor>Notes you type appear here.<//>`}
      <//>
    <//>
    <${Box} paddingX=${1}>
      <${Text} dimColor>${session.book.mode === 'room' ? 'Speaker ' : 'Remote speaker '}<//>
      ${roster.length ? roster.map((n, i) => html`<${Text} key=${n} inverse=${session.book.current === n} color=${colorFor(n, me)}> ${i + 1} ${n} <//>`) : html`<${Text} dimColor>(none — /add Name, Name · /preset load <name> · /ics file)<//>`}
      <${Text} dimColor>  Tab = next<//>
    <//>
    <${Box} paddingX=${1}><${Text} color=${statusColor} wrap="truncate-end">${confirm ? 'Press Ctrl+C again to stop and save the meeting' : status}<//><//>
    <${Box} paddingX=${1}><${Text} color="cyan">› <//>${shown ? html`<${Text}>${shown.slice(0, cur)}<${Text} inverse>${shown[cur] ?? ' '}<//>${shown.slice(cur + 1)}<//>` : html`<${Text} inverse> <//><${Text} dimColor> ${hint}<//>`}<//>
    ${showHelp ? html`<${Box} paddingX=${1} borderStyle="single"><${Text}>${HELP}<//><//>` : html`<${Box} paddingX=${1}><${Text} dimColor>Ctrl+P pause · Tab speaker · PgUp/PgDn scroll · /help · /stop<//><//>`}
  <//>`;
}

export async function runTui(session, { autoStart = false } = {}) {
  session.on('progress', (t) => { session.progressText = t; });
  const inst = render(html`<${App} session=${session} autoStart=${autoStart} />`, { exitOnCtrlC: false });
  await inst.waitUntilExit();
  return session.result;
}
