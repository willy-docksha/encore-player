// mixed stereo float -> mp3 bytes, off the main thread (mixer export)

import { Mp3Encoder } from "https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/+esm";
import { encodeMp3 } from "./mp3.js";

self.onmessage = ({ data: { left, right, sampleRate } }) => {
  try {
    const bytes = encodeMp3(Mp3Encoder, left, right, { sampleRate, kbps: 192 });
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
