import http from 'node:http';

export async function startMockOllama({ model = 'qwen2.5:7b-instruct', fail = false } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/api/tags') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: model }] })); return; }
      const j = JSON.parse(body); requests.push(j);
      if (fail) { res.writeHead(500); res.end('boom'); return; }
      if (j.model !== model) { res.writeHead(404); res.end('{}'); return; }
      const out = {};
      for (const k of Object.keys(j.format.properties)) {
        out[k] = ({ summary: 'The team reviewed the Q3 budget.', discussion: '- Q3 budget review', decisions: '- None recorded.', actions: '- [ ] **Anil**: send the deck (due: Friday)',
          questions: 'None recorded.', meeting_title: 'Q3 Budget Review' })[k] ?? `Generated ${k}`;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(out) } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}
