// Meeting metadata from a calendar invite (.ics): title, start time and attendee names -> speaker roster.
const unfold = (t) => t.replace(/\r?\n[ \t]/g, '');
const unescapeText = (s) => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

const prettyFromEmail = (email) => email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function parseIcs(text) {
  const lines = unfold(String(text)).split(/\r?\n/);
  const ev = { title: '', start: null, attendees: [], organizer: null };
  let inEvent = false;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { inEvent = true; continue; }
    if (/^END:VEVENT/i.test(line)) break;
    if (!inEvent) continue;
    const idx = line.indexOf(':'); if (idx < 0) continue;
    const head = line.slice(0, idx); const value = line.slice(idx + 1);
    const [prop, ...params] = head.split(';');
    const P = prop.toUpperCase();
    if (P === 'SUMMARY') ev.title = unescapeText(value).trim();
    else if (P === 'DTSTART') {
      const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
      if (m) ev.start = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    } else if (P === 'ATTENDEE' || P === 'ORGANIZER') {
      const cn = params.map((p) => /^CN=(.*)$/i.exec(p)).find(Boolean);
      const email = value.replace(/^mailto:/i, '').trim();
      const name = (cn ? cn[1].replace(/^"|"$/g, '') : '') || (email ? prettyFromEmail(email) : '');
      if (name) { const a = { name, email }; if (P === 'ORGANIZER') ev.organizer = a; ev.attendees.push(a); }
    }
  }
  const seen = new Set();
  ev.attendees = ev.attendees.filter((a) => { const k = a.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return ev;
}
