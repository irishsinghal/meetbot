// Minimal PCM16 WAV reader/writer, plus conversion to MeetBot's wire format (stereo, 16 kHz, int16 LE).
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12; let fmt = null; let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4); let size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === 'data') { size = Math.min(size, buf.length - body); data = buf.subarray(body, body + size); break; }
    pos = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('Malformed WAV (no fmt/data chunk)');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported (convert with: ffmpeg -i in.mp3 -ar 16000 -ac 2 out.wav)');
  return { ...fmt, data };
}

export function writeWav({ channels, rate, samples }) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** -> Buffer of interleaved stereo int16 @16 kHz. `as`: where a mono file goes: 'system' (right), 'mic' (left), 'both'. */
export function toStereo16k(wav, as = 'system') {
  const { channels, rate, data } = wav;
  const n = Math.floor(data.length / 2 / channels);
  const src = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + n * channels * 2));
  const at = (i, c) => src[Math.min(n - 1, i) * channels + c];
  const outN = Math.floor((n * 16000) / rate);
  const out = new Int16Array(outN * 2);
  for (let j = 0; j < outN; j++) {
    const p = (j * rate) / 16000; const i = Math.floor(p); const f = p - i;
    const s = (c) => at(i, c) * (1 - f) + at(i + 1, c) * f;
    let l; let r;
    if (channels >= 2) { l = s(0); r = s(1); } else { const m = s(0); l = as === 'mic' || as === 'both' ? m : 0; r = as === 'system' || as === 'both' ? m : 0; }
    out[j * 2] = l; out[j * 2 + 1] = r;
  }
  return Buffer.from(out.buffer);
}

/** RMS of each channel of a stereo int16 buffer, 0..1. */
export function stereoLevels(buf) {
  const a = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  let l = 0; let r = 0; const frames = a.length >> 1;
  for (let i = 0; i < frames; i++) { l += a[2 * i] * a[2 * i]; r += a[2 * i + 1] * a[2 * i + 1]; }
  const f = (x) => (frames ? Math.sqrt(x / frames) / 32768 : 0);
  return { mic: f(l), sys: f(r) };
}
