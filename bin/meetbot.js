#!/usr/bin/env node
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, redact } from '../src/config.js';
import { FileSource, SidecarSource } from '../src/audio/source.js';
import { MeetingSession } from '../src/session.js';
import { initErrLog, logFile, onSignal, writeLog } from '../src/errlog.js';
import { applyIcs, applyPreset, presetStore } from '../src/commands.js';

const USAGE = `MeetBot - terminal meeting recorder with a live notepad

  meetbot [start] [options]       record a meeting or a voice note (opens a local browser UI)
  meetbot note [options]          same, but starts recording immediately (quick capture)
  meetbot summarize <folder>      re-run the summary for a saved meeting  [--template name|file]
  meetbot retranscribe <folder>   redo transcript + summary from a kept recording (local Whisper), then delete it
  meetbot setup                   first-run wizard: save settings, install packages, pull the model, run doctor
                                  [--jwt <jwt>] [--recording on|off] [--sa-config <id>] [--me <name>] [--out <dir>] [--model <name>] [--skip-install] [-y]
  meetbot layout [flat|day|nested] [--migrate|--no-migrate]
                                  choose how meeting folders are organised; offers to move existing ones
  meetbot doctor                  check setup (Voicegain JWT, audio capture, Ollama, folders)
  meetbot probe [--seconds 15]    open a test Voicegain session and show the raw websocket messages
  meetbot presets | templates | devices

start options:
  --title <text>        meeting title (default: the local model suggests one)
  --preset <name>       load saved speakers (see /preset in the app)
  --ics <file>          load title + attendees from a calendar invite
  --attendee <name>     add a participant (repeatable)
  --template <name|file>  summary template (default: general-meeting)
  --me <name>           your name in the transcript
  --room                everyone is on the microphone (no remote channel)
  --no-system / --no-mic   capture only one side
  --out <dir>           output folder (default: Documents/MeetBot)
  --file <wav>          replay a 16-bit WAV instead of live capture (--file-as system|mic, --speed 2)
  --tui                 use the terminal UI instead of the browser UI
  --no-open / --no-popup / --port N  browser UI: don't open it automatically / use a normal tab, not a popup window / fixed port
  --plain               line-based mode instead of any UI
  --no-summary          skip the local summary
  -y, --auto-start      start recording immediately
`;

const opts = {
  title: { type: 'string' }, preset: { type: 'string' }, ics: { type: 'string' }, attendee: { type: 'string', multiple: true },
  template: { type: 'string' }, me: { type: 'string' }, room: { type: 'boolean' }, 'no-system': { type: 'boolean' }, 'no-mic': { type: 'boolean' },
  out: { type: 'string' }, file: { type: 'string' }, 'file-as': { type: 'string' }, speed: { type: 'string' }, plain: { type: 'boolean' },
  'no-summary': { type: 'boolean' }, 'auto-start': { type: 'boolean', short: 'y' }, seconds: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  jwt: { type: 'string' }, recording: { type: 'string' }, 'sa-config': { type: 'string' }, model: { type: 'string' }, 'skip-install': { type: 'boolean' }, yes: { type: 'boolean' },
  migrate: { type: 'boolean' }, 'no-migrate': { type: 'boolean' },
  mic: { type: 'string' }, loopback: { type: 'string' }, tui: { type: 'boolean' }, web: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'no-popup': { type: 'boolean' }, port: { type: 'string' },
};

function sourceFactory(cfg, v) {
  return () => {
    if (v.file) return new FileSource(v.file, { as: v['file-as'] || 'system', speed: Number(v.speed || 1) });
    const args = [];
    if (v['no-mic']) args.push('--no-mic'); if (v['no-system'] || v.room) args.push('--no-system');
    if (v.mic) args.push('--mic', v.mic); if (v.loopback) args.push('--loopback', v.loopback);
    return new SidecarSource({ python: cfg.capture.python, args });
  };
}

/** Stopping is instant (draft files); the Whisper pass and model summary finish here. Ctrl+C skips them. */
async function finishInBackground(session) {
  if (!session.finalizing) return;
  console.log('Finishing in the background (improved transcript + summary). Ctrl+C to skip; the draft is already saved.');
  const log = (m) => { if (m) console.log(`  ${m}`); }; session.on('progress', log);
  await session.whenFinalized(); session.off('progress', log);
}

async function main() {
  const { values: v, positionals } = parseArgs({ options: opts, allowPositionals: true, strict: false });
  let cmd = positionals[0] && !positionals[0].startsWith('-') ? positionals[0] : 'start';
  if (cmd === 'note') { cmd = 'start'; v['auto-start'] = true; }
  if (v.help || cmd === 'help') { console.log(USAGE); return; }
  const cfg = loadConfig({ ...(v.out ? { outputDir: path.resolve(v.out) } : {}), ...(v.me ? { me: v.me } : {}), ...(v.template ? { template: v.template } : {}) });

  initErrLog(cfg);

  if (cmd === 'version') { console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version); return; }
  if (cmd === 'templates') { const { listTemplates } = await import('../src/summarize/template.js'); console.log(listTemplates().join('\n')); return; }
  if (cmd === 'presets') { const l = presetStore().list(); console.log(l.length ? l.join('\n') : 'No presets yet. In a meeting: /add names, then /preset save <name>.'); return; }
  if (cmd === 'devices') { const { spawnSync } = await import('node:child_process'); const { SIDECAR } = await import('../src/audio/source.js'); const r = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [SIDECAR, '--list'], { encoding: 'utf8' }); console.log(r.stdout || r.stderr); return; }
  if (cmd === 'setup') {
    const { setup } = await import('../src/setup.js');
    const r = await setup(cfg, { recording: v.recording, jwt: v.jwt, saConfig: v['sa-config'], me: v.me, out: v.out, model: v.model, 'skip-install': v['skip-install'], yes: v.yes || v['auto-start'] });
    process.exitCode = r.ok ? 0 : 1; return;
  }
  if (cmd === 'layout') {
    const { reconfigureLayout } = await import('../src/layout.js');
    const readline = await import('node:readline/promises');
    const rl = process.stdin.isTTY && process.stdout.isTTY && !v.yes ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
    try {
      await reconfigureLayout(cfg, { layout: positionals[1], migrate: v['no-migrate'] ? false : v.migrate ? true : undefined }, {
        ask: async (q, def) => (rl ? (await rl.question(`${q} [${def}]: `)).trim() || def : def),
        confirm: async (q) => (rl ? /^(y|yes|)$/i.test((await rl.question(`${q} [Y/n]: `)).trim()) : false),
      });
    } finally { rl?.close(); }
    return;
  }
  if (cmd === 'doctor') {
    const { doctor } = await import('../src/doctor.js');
    const rows = await doctor(cfg);
    for (const r of rows) console.log(`${r.ok ? '  ok ' : ' FAIL'}  ${r.label}${r.detail ? `: ${r.detail}` : ''}`);
    process.exitCode = rows.every((r) => r.ok) ? 0 : 1; return;
  }
  if (cmd === 'summarize') {
    const dir = positionals[1]; if (!dir) throw new Error('Usage: meetbot summarize <meeting folder> [--template name]');
    const { resummarize } = await import('../src/recover.js');
    const r = await resummarize(path.resolve(dir), cfg, { template: v.template, onProgress: (m) => console.log(m) });
    console.log(`Wrote ${r.file} (template: ${r.template})${r.warning ? `\n! ${r.warning}` : ''}`); return;
  }
  if (cmd === 'retranscribe') {
    const dir = positionals[1]; if (!dir) throw new Error('Usage: meetbot retranscribe <meeting folder>');
    const { retranscribeMeeting } = await import('../src/refine.js');
    const r = await retranscribeMeeting(path.resolve(dir), cfg, { onProgress: (m) => console.log(typeof m === 'number' ? `${Math.round(m * 100)}%` : m) });
    console.log(`Rewrote transcript.md (${r.lines} lines) and ${r.summary}; the recording was deleted.${r.warning ? `
! ${r.warning}` : ''}`); return;
  }
  if (cmd === 'probe') {
    const { probe } = await import('../src/probe.js');
    await probe(cfg, { seconds: Number(v.seconds || 15), source: sourceFactory(cfg, v)() }); return;
  }
  if (cmd !== 'start') { console.error(`Unknown command "${cmd}".\n\n${USAGE}`); process.exitCode = 2; return; }

  // ---- start ----
  const session = new MeetingSession(cfg, { sourceFactory: sourceFactory(cfg, v) });
  if (v.title) session.title = v.title;
  if (v.room) session.setMode('room');
  if (v.preset) { const p = presetStore().load(v.preset); if (!p) throw new Error(`No preset "${v.preset}". Existing: ${presetStore().list().join(', ') || 'none'}`); applyPreset(session, p); }
  if (v.ics) applyIcs(session, fs.readFileSync(v.ics, 'utf8'));
  for (const a of v.attendee || []) session.addPerson(a);
  if (v.me) session.setMe(v.me);

  if (!cfg.voicegain.jwt) console.error('Note: VOICEGAIN_JWT is not set; run "meetbot doctor".');
  const summarize = !v['no-summary'];
  const origStop = session.stop.bind(session); session.stop = (o = {}) => origStop({ summarize: o.summarize !== false && summarize });

  // Terminal closed / killed mid-meeting: save what we have instead of losing the transcript.
  let saving = false;
  onSignal(async (sig) => {
    if (saving) return; saving = true;
    if (session.state === 'done') { writeLog('warn', `${sig} while finishing the notes; exiting (the draft is saved)`); process.exit(130); }
    writeLog('warn', `${sig} while ${session.state}; saving the meeting before exit`);
    const t = setTimeout(() => process.exit(130), 30000);
    try { if (['recording', 'paused'].includes(session.state)) await session.stop(); } catch (e) { writeLog('error', e); }
    clearTimeout(t); process.exit(130);
  });

  if (v.plain || (!v.web && (!process.stdin.isTTY || !process.stdout.isTTY))) {
    const { runPlain } = await import('../src/tui/plain.js');
    await runPlain(session, { autoStart: true, stopAfterSourceEnd: !!v.file });
  } else if (!v.tui) {
    const { startWebUi } = await import('../src/web/server.js');
    const ui = await startWebUi(session, { port: Number(v.port || 0), open: !v['no-open'], popup: !v['no-popup'] && cfg.ui?.popup !== false, autoStart: !!v['auto-start'] });
    console.log(`MeetBot is running at ${ui.url}
(opened in a popup window; Ctrl+C here stops and saves the meeting)`);
    await ui.finished; ui.close();
    await finishInBackground(session);
    if (session.result) console.log(`Saved to ${session.result.dir}`);
  } else {
    const { runTui } = await import('../src/tui/app.js');
    const r = await runTui(session, { autoStart: !!v['auto-start'] });
    await finishInBackground(session);
    if (r) console.log(`Saved to ${r.dir}`);
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
  writeLog('fatal', e);
  console.error(`Error: ${redact(e.message, loadConfig())}
Details logged to ${logFile() || 'n/a'}`); process.exit(1);
});
