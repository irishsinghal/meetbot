// Normalizes a Voicegain real-time Speech Analytics websocket payload (see "Websocket Payload for SA").
// One message may carry: speaker[], word[] | wordEdit[] | segment[], plus analytics arrays we only pass through.
const ANALYTICS = ['emotion', 'ner', 'keyword', 'phrase', 'phraseGroup', 'review', 'kbRecommendation', 'answer'];
const arr = (v) => (Array.isArray(v) ? v : []);

const word = (w) => ({
  text: String(w?.utt ?? ''), conf: w?.conf, spk: w?.spk,
  start: Number(w?.start ?? 0), end: Number(w?.end ?? w?.start ?? 0),
});

export function parsePayload(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const out = { speakers: [], words: [], edits: [], segments: [], analytics: {} };
  for (const s of arr(msg.speaker)) {
    if (Number.isInteger(s?.spk)) out.speakers.push({ spk: s.spk, chn: s.chn, agent: !!s.agent, diarized: !!s.diarized });
  }
  out.words = arr(msg.word).map(word).filter((w) => w.text);
  for (const e of arr(msg.wordEdit)) {
    out.edits.push({ del: Number(e?.del ?? 0), spk: e?.spk, words: arr(e?.words).map(word).filter((w) => w.text) });
  }
  for (const s of arr(msg.segment)) {
    const text = String(s?.alternatives?.[0]?.text ?? '').trim();
    out.segments.push({
      final: s?.type === 'recognition', spk: s?.spk, start: Number(s?.time ?? 0),
      end: Number(s?.time ?? 0) + Number(s?.duration ?? 0), text, conf: s?.alternatives?.[0]?.confidence,
    });
  }
  for (const k of ANALYTICS) if (arr(msg[k]).length) out.analytics[k] = msg[k];
  return out;
}
