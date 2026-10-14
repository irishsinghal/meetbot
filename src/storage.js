// <Documents>/MeetBot/<layout path, see LAYOUTS>/ : transcript.md, personal-notes.md, summary.md (+ .data/ for recovery).
import fs from 'node:fs';
import path from 'node:path';

const p2 = (n) => String(n).padStart(2, '0');
export const folderName = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;

const date = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const time = (d) => `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;

/** Folder layouts: how a meeting's start time maps to path segments under the output folder. */
export const LAYOUTS = {
  flat:   { example: '2026-10-14_13-30-37', segments: (d) => [folderName(d)] },
  day:    { example: '2026-10-14/13-30-37', segments: (d) => [date(d), time(d)] },
  nested: { example: '2026/10/14/13-30-37', segments: (d) => [String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()), time(d)] },
};

/** Free path for a new meeting folder (appends _2, _3 ... on a clash). */
function freeDir(base) {
  let dir = base; let n = 2;
  while (fs.existsSync(dir)) dir = `${base}_${n++}`;
  return dir;
}

export class MeetingFolder {
  constructor(outputDir, startedAt, layout = 'flat') {
    const dir = freeDir(path.join(outputDir, ...(LAYOUTS[layout] || LAYOUTS.flat).segments(startedAt)));
    this.dir = dir; this.dataDir = path.join(dir, '.data');
    fs.mkdirSync(this.dataDir, { recursive: true });
  }
  file(name) { return path.join(this.dir, name); }
  data(name) { return path.join(this.dataDir, name); }
  appendJsonl(name, obj) { fs.appendFileSync(this.data(name), `${JSON.stringify(obj)}\n`); }
  writeMeta(meta) { fs.writeFileSync(this.data('meeting.json'), JSON.stringify(meta, null, 2)); }
  write(name, text) { fs.writeFileSync(this.file(name), text, 'utf8'); }
}

export function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

/** Every meeting folder under `root` (up to 4 levels deep): the ones holding .data/meeting.json. */
export function findMeetings(root, depth = 4) {
  const found = [];
  const walk = (dir, d) => {
    const meta = path.join(dir, '.data', 'meeting.json');
    if (fs.existsSync(meta)) {
      let startedAt = null;
      try { startedAt = new Date(JSON.parse(fs.readFileSync(meta, 'utf8')).startedAt); } catch { /* fall back below */ }
      if (!startedAt || Number.isNaN(startedAt.getTime())) startedAt = fs.statSync(dir).birthtime;
      found.push({ dir, startedAt }); return;
    }
    if (d <= 0) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), d - 1);
  };
  walk(root, depth);
  return found;
}

/** Moves needed to bring every meeting under `root` into `layout` (empty when already there). */
export function planMigration(root, layout) {
  const l = LAYOUTS[layout]; if (!l) throw new Error(`Unknown layout "${layout}". Choose: ${Object.keys(LAYOUTS).join(', ')}`);
  const taken = new Set(); const moves = [];
  for (const m of findMeetings(root).sort((a, b) => a.startedAt - b.startedAt)) {
    const want = path.join(root, ...l.segments(m.startedAt));
    if (m.dir === want || m.dir.startsWith(`${want}_`)) { taken.add(m.dir); continue; } // already in place (or a clash suffix)
    let to = want; let n = 2;
    while (fs.existsSync(to) || taken.has(to)) to = `${want}_${n++}`;
    taken.add(to); moves.push({ from: m.dir, to });
  }
  return moves;
}

/** Performs the moves, then removes parent folders left empty. */
export function applyMigration(root, moves) {
  let moved = 0; const failed = [];
  for (const { from, to } of moves) {
    try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to); moved++; } catch (e) { failed.push({ from, error: e.message }); }
  }
  for (const { from } of moves) {
    for (let d = path.dirname(from); d.startsWith(root) && d !== root; d = path.dirname(d)) {
      try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    }
  }
  return { moved, failed };
}
