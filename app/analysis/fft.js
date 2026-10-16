// radix-2 fft for power-of-two sizes, plus a real-input fft built on a half-size complex one

const plans = new Map();

function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (n & (n - 1)) throw new Error(`fft size ${n} is not a power of two`);
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0, x = i; b < bits; b++, x >>= 1) r = (r << 1) | (x & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let k = 0; k < n >> 1; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  p = { n, rev, cos, sin };
  plans.set(n, p);
  return p;
}

// in-place complex fft; inverse is unscaled (divide by n yourself)
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cos[t];
        const wi = sgn * sin[t];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// real fft of x (length n, power of two) -> outRe/outIm of length n/2 + 1
export class RealFFT {
  constructor(n) {
    this.n = n;
    this.h = n >> 1;
    this.zr = new Float64Array(this.h);
    this.zi = new Float64Array(this.h);
    this.c = new Float64Array(this.h);
    this.s = new Float64Array(this.h);
    for (let k = 0; k < this.h; k++) {
      this.c[k] = Math.cos((2 * Math.PI * k) / n);
      this.s[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  forward(x, outRe, outIm) {
    const { h, zr, zi, c, s } = this;
    for (let k = 0; k < h; k++) { zr[k] = x[2 * k]; zi[k] = x[2 * k + 1]; }
    fft(zr, zi);
    outRe[0] = zr[0] + zi[0]; outIm[0] = 0;
    outRe[h] = zr[0] - zi[0]; outIm[h] = 0;
    for (let k = 1; k < h; k++) {
      const ar = zr[k], ai = zi[k], br = zr[h - k], bi = -zi[h - k];
      const er = (ar + br) / 2, ei = (ai + bi) / 2; // even part
      const or = (ai - bi) / 2, oi = -(ar - br) / 2; // odd part = (a - b) / 2i
      // twiddle e^{-2 pi i k / n}
      const tr = c[k], ti = -s[k];
      outRe[k] = er + or * tr - oi * ti;
      outIm[k] = ei + or * ti + oi * tr;
    }
  }

  // inverse of forward (scaled, so inverse(forward(x)) == x)
  inverse(re, im, out) {
    const { h, n, zr, zi, c, s } = this;
    for (let k = 0; k < h; k++) {
      const ar = re[k], ai = im[k], br = re[h - k], bi = -im[h - k];
      const er = (ar + br), ei = (ai + bi);
      const dr = (ar - br), di = (ai - bi);
      // odd = d * e^{+2 pi i k / n}, z = even + i * odd
      const tr = c[k], ti = s[k];
      const orr = dr * tr - di * ti, oi = dr * ti + di * tr;
      zr[k] = (er - oi) / 2;
      zi[k] = (ei + orr) / 2;
    }
    fft(zr, zi, true);
    for (let k = 0; k < h; k++) { out[2 * k] = (zr[k] * 2) / n; out[2 * k + 1] = (zi[k] * 2) / n; }
  }
}
