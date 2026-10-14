// <Documents>/MeetBot/<YYYY-MM-DD_HH-mm-ss>/ : transcript.md, personal-notes.md, summary.md (+ .data/ for recovery).
import fs from 'node:fs';
import path from 'node:path';

const p2 = (n) => String(n).padStart(2, '0');
export const folderName = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;

export class MeetingFolder {
  constructor(outputDir, startedAt) {
    let dir = path.join(outputDir, folderName(startedAt)); let n = 2;
    while (fs.existsSync(dir)) dir = path.join(outputDir, `${folderName(startedAt)}_${n++}`);
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
