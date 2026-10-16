// stereo float -> mp3 bytes with lamejs (stems for the player mixer)

const BLOCK = 1152 * 32;

export function encodeMp3(Mp3Encoder, left, right, { sampleRate = 44100, kbps = 160 } = {}) {
  const enc = new Mp3Encoder(2, sampleRate, kbps);
  const l = new Int16Array(BLOCK), r = new Int16Array(BLOCK);
  const parts = [];
  let size = 0;
  const s16 = (v) => (v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767));
  for (let i = 0; i < left.length; i += BLOCK) {
    const n = Math.min(BLOCK, left.length - i);
    for (let k = 0; k < n; k++) { l[k] = s16(left[i + k]); r[k] = s16(right[i + k]); }
    const out = enc.encodeBuffer(l.subarray(0, n), r.subarray(0, n));
    if (out.length) { parts.push(out); size += out.length; }
  }
  const tail = enc.flush();
  if (tail.length) { parts.push(tail); size += tail.length; }
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }
  return bytes;
}
