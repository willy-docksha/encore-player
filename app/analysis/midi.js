// standard midi files from note lists (port of write_midi in backend/pipeline.py)

// program is 0-based: 33 = electric bass (finger), 53 = voice oohs, 0 = piano, 25 = steel guitar
export function midiFile(notes, bpm, program = 33, channel = 0) {
  const ppq = 480;
  bpm = bpm || 120;
  const tick = (sec) => Math.round(((sec * bpm) / 60) * ppq);
  const events = [];
  for (const nt of notes) {
    const vel = Math.trunc(40 + 87 * (nt.v ?? 0.8));
    events.push([tick(nt.t), 1, nt.midi, vel]);
    events.push([tick(nt.t + nt.d), 0, nt.midi, 0]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const vlq = (v) => {
    const buf = [v & 0x7f];
    v >>= 7;
    while (v) { buf.push((v & 0x7f) | 0x80); v >>= 7; }
    return buf.reverse();
  };
  const track = [];
  const usPerBeat = Math.trunc(60000000 / bpm);
  track.push(0x00, 0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff);
  track.push(0x00, 0xc0 | channel, program);
  let last = 0;
  for (const [t, on, pitch, vel] of events) {
    track.push(...vlq(t - last), (on ? 0x90 : 0x80) | channel, pitch, vel);
    last = t;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const u32 = (v) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  return new Uint8Array([
    ...[0x4d, 0x54, 0x68, 0x64], ...u32(6), ...u16(0), ...u16(1), ...u16(ppq),
    ...[0x4d, 0x54, 0x72, 0x6b], ...u32(track.length), ...track,
  ]);
}

// general midi drums on channel 10: kick 36, snare 38, closed hi-hat 42, mid tom 47
export function drumMidiFile(drums, bpm) {
  const keys = { kick: 36, snare: 38, hat: 42, tom: 47 };
  const notes = [];
  for (const [k, ts] of Object.entries(drums || {})) {
    if (!(k in keys)) continue;
    for (const t of ts) notes.push({ t, d: 0.1, midi: keys[k], v: k !== "hat" ? 0.85 : 0.6 });
  }
  notes.sort((a, b) => a.t - b.t);
  return midiFile(notes, bpm, 0, 9);
}
