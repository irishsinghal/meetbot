// Local LLM via Ollama (http://127.0.0.1:11434). Nothing here leaves your machine.
export class OllamaError extends Error {}

export async function chatJson({ url, model, ctx = 16384, maxTokens, system, user, schema, fetchImpl = fetch, signal }) {
  let res;
  try {
    res = await fetchImpl(`${url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ model, stream: false, keep_alive: '30m', format: schema, options: { temperature: 0.2, num_ctx: ctx, ...(maxTokens ? { num_predict: maxTokens } : {}) },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
  } catch (e) {
    throw new OllamaError(`Can't reach Ollama at ${url}. Start it (the Ollama app, or "ollama serve"). (${e.cause?.code || e.message})`);
  }
  if (res.status === 404) throw new OllamaError(`Model "${model}" is not installed. Run: ollama pull ${model}`);
  if (!res.ok) throw new OllamaError(`Ollama error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content = data?.message?.content ?? '';
  try { return JSON.parse(content); } catch { throw new OllamaError(`The model returned invalid JSON: ${content.slice(0, 160)}`); }
}

export async function listModels(url, fetchImpl = fetch) {
  const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()).models.map((m) => m.name);
}

/** Load the model into memory ahead of time so the first live request (catch-up, tag alert) is not slow. Never throws. */
export async function warmModel({ url, model, fetchImpl = fetch }) {
  try { await fetchImpl(`${url.replace(/\/$/, '')}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: '', keep_alive: '30m' }), signal: AbortSignal.timeout(120000) }); } catch { /* Ollama not running: nothing to warm */ }
}
