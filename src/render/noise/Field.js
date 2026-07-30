/**
 * `Field` — a square, wrap-around Float32 scalar image, and the filters that
 * turn it into PBR maps.
 *
 * A field is the intermediate representation for every procedural material:
 * we build a *height* field first, then derive the normal map (Sobel), the
 * ambient occlusion (multi-tap horizon approximation) and often the roughness
 * from it. Because every accessor wraps, filters never introduce a seam.
 *
 * Ops are in-place and chainable unless noted. Scratch buffers are pooled per
 * size so repeated builds don't thrash the GC.
 */

const _pool = new Map();

/** Borrow a pooled Float32Array of `n` elements (contents undefined). */
function borrow(n, slot) {
  const key = n + ':' + slot;
  let a = _pool.get(key);
  if (!a) { a = new Float32Array(n); _pool.set(key, a); }
  return a;
}

/** Drop pooled scratch memory (call after a big batch bake). */
export function releaseFieldScratch() {
  _pool.clear();
}

/**
 * Smallest integer `step` such that `step` divides `n` exactly and
 * `n / step <= target`. Guarantees a downsample keeps perfect registration.
 */
export function exactStep(n, target) {
  for (let s = 1; s <= n; s++) if (n % s === 0 && n / s <= target) return s;
  return n;
}

export class Field {
  /**
   * @param {number} size edge length in texels (power of two recommended)
   * @param {Float32Array} [data]
   */
  constructor(size, data) {
    this.size = size | 0;
    this.data = data ?? new Float32Array(this.size * this.size);
  }

  /** @param {number} size @param {(u:number,v:number,x:number,y:number)=>number} fn */
  static from(size, fn) {
    const f = new Field(size);
    f.fill(fn);
    return f;
  }

  static constant(size, value) {
    const f = new Field(size);
    if (value !== 0) f.data.fill(value);
    return f;
  }

  clone() {
    return new Field(this.size, this.data.slice());
  }

  /** Fill from a generator. `u,v` are texel centres in [0,1). */
  fill(fn) {
    const n = this.size, d = this.data, inv = 1 / n;
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++, i++) {
        d[i] = fn((x + 0.5) * inv, v, x, y);
      }
    }
    return this;
  }

  /** Visit every texel: fn(value, u, v, x, y) → new value. */
  map(fn) {
    const n = this.size, d = this.data, inv = 1 / n;
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      for (let x = 0; x < n; x++, i++) {
        d[i] = fn(d[i], (x + 0.5) * inv, v, x, y);
      }
    }
    return this;
  }

  // ── access ───────────────────────────────────────────────────────────────

  /** Wrapped integer fetch. */
  get(x, y) {
    const n = this.size;
    x = x % n; if (x < 0) x += n;
    y = y % n; if (y < 0) y += n;
    return this.data[y * n + x];
  }

  set(x, y, v) {
    const n = this.size;
    x = x % n; if (x < 0) x += n;
    y = y % n; if (y < 0) y += n;
    this.data[y * n + x] = v;
    return this;
  }

  addAt(x, y, v) {
    const n = this.size;
    x = x % n; if (x < 0) x += n;
    y = y % n; if (y < 0) y += n;
    this.data[y * n + x] += v;
    return this;
  }

  maxAt(x, y, v) {
    const n = this.size;
    x = x % n; if (x < 0) x += n;
    y = y % n; if (y < 0) y += n;
    const i = y * n + x;
    if (v > this.data[i]) this.data[i] = v;
    return this;
  }

  /** Bilinear sample with wrapping. `u,v` in texel units (not normalised). */
  bilinear(u, v) {
    const x0 = Math.floor(u), y0 = Math.floor(v);
    const fx = u - x0, fy = v - y0;
    const a = this.get(x0, y0), b = this.get(x0 + 1, y0);
    const c = this.get(x0, y0 + 1), d = this.get(x0 + 1, y0 + 1);
    const t = a + (b - a) * fx;
    const s = c + (d - c) * fx;
    return t + (s - t) * fy;
  }

  /** Bilinear sample with normalised uv in [0,1). */
  sample01(u, v) {
    const n = this.size;
    return this.bilinear(u * n - 0.5, v * n - 0.5);
  }

  // ── arithmetic ───────────────────────────────────────────────────────────

  addScalar(k) { const d = this.data; for (let i = 0; i < d.length; i++) d[i] += k; return this; }
  mulScalar(k) { const d = this.data; for (let i = 0; i < d.length; i++) d[i] *= k; return this; }

  add(other, k = 1) {
    const a = this.data, b = other.data;
    for (let i = 0; i < a.length; i++) a[i] += b[i] * k;
    return this;
  }

  mul(other) {
    const a = this.data, b = other.data;
    for (let i = 0; i < a.length; i++) a[i] *= b[i];
    return this;
  }

  maxWith(other) {
    const a = this.data, b = other.data;
    for (let i = 0; i < a.length; i++) if (b[i] > a[i]) a[i] = b[i];
    return this;
  }

  minWith(other) {
    const a = this.data, b = other.data;
    for (let i = 0; i < a.length; i++) if (b[i] < a[i]) a[i] = b[i];
    return this;
  }

  /** this = lerp(this, other, t) where t may be a number or a Field. */
  mix(other, t) {
    const a = this.data, b = other.data;
    if (typeof t === 'number') {
      for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * t;
    } else {
      const m = t.data;
      for (let i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * m[i];
    }
    return this;
  }

  clamp(lo = 0, hi = 1) {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = d[i] < lo ? lo : d[i] > hi ? hi : d[i];
    return this;
  }

  pow(k) {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = Math.pow(d[i] < 0 ? 0 : d[i], k);
    return this;
  }

  invert() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = 1 - d[i];
    return this;
  }

  abs() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = d[i] < 0 ? -d[i] : d[i];
    return this;
  }

  /** Contrast around `pivot`. */
  contrast(k, pivot = 0.5) {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = (d[i] - pivot) * k + pivot;
    return this;
  }

  /** Remap [a,b] → [c,d] (values outside [a,b] extrapolate). */
  remap(a, b, c, e) {
    const d = this.data;
    const s = b === a ? 0 : (e - c) / (b - a);
    for (let i = 0; i < d.length; i++) d[i] = c + (d[i] - a) * s;
    return this;
  }

  /** Smoothstep threshold in place. */
  smoothstep(a, b) {
    const d = this.data;
    const inv = b === a ? 0 : 1 / (b - a);
    for (let i = 0; i < d.length; i++) {
      let t = (d[i] - a) * inv;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d[i] = t * t * (3 - 2 * t);
    }
    return this;
  }

  range() {
    const d = this.data;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return { min: lo, max: hi };
  }

  /** Rescale so the extremes land on [lo,hi]. No-op for a constant field. */
  normalize(lo = 0, hi = 1) {
    const { min, max } = this.range();
    if (max - min < 1e-9) { this.data.fill((lo + hi) * 0.5); return this; }
    return this.remap(min, max, lo, hi);
  }

  mean() {
    const d = this.data;
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i];
    return s / d.length;
  }

  // ── filters ──────────────────────────────────────────────────────────────

  /**
   * Wrapped separable box blur, O(n) per axis via a running sum.
   * `radius` in texels (0 = no-op).
   */
  boxBlur(radius) {
    const r = Math.max(0, Math.round(radius));
    if (r === 0) return this;
    const n = this.size, d = this.data;
    const tmp = borrow(d.length, 'blurA');
    const w = 2 * r + 1, invW = 1 / w;

    // Horizontal
    for (let y = 0; y < n; y++) {
      const row = y * n;
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        let xx = k % n; if (xx < 0) xx += n;
        sum += d[row + xx];
      }
      for (let x = 0; x < n; x++) {
        tmp[row + x] = sum * invW;
        let xo = (x - r) % n; if (xo < 0) xo += n;
        let xi = (x + r + 1) % n; if (xi < 0) xi += n;
        sum += d[row + xi] - d[row + xo];
      }
    }
    // Vertical
    for (let x = 0; x < n; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        let yy = k % n; if (yy < 0) yy += n;
        sum += tmp[yy * n + x];
      }
      for (let y = 0; y < n; y++) {
        d[y * n + x] = sum * invW;
        let yo = (y - r) % n; if (yo < 0) yo += n;
        let yi = (y + r + 1) % n; if (yi < 0) yi += n;
        sum += tmp[yi * n + x] - tmp[yo * n + x];
      }
    }
    return this;
  }

  /**
   * Approximate Gaussian blur.
   *
   * Small sigmas are handled carefully: the minimum box radius is 1, and three
   * stacked 3x3 passes are a ~7x7 average — enough to obliterate thin stamped
   * detail like grass blades or scratches. So sub-pixel sigmas are a no-op and
   * sub-1.0 sigmas get a single pass.
   */
  blur(sigma) {
    if (sigma <= 0.4) return this;
    if (sigma < 0.95) return this.boxBlur(1);
    const r = Math.max(1, Math.round(sigma * 0.8));
    return this.boxBlur(r).boxBlur(r).boxBlur(Math.max(1, r >> 1));
  }

  /**
   * Wrapped **directional** blur — the smear that sells brushed metal, motion
   * streaks, rain runs and carpet nap.
   *
   * @param {number} angle radians, 0 = along +x
   * @param {number} length total smear length in texels
   * @param {number} [taps]
   * @param {number} [bias] 0 = symmetric, 1 = trails only in +direction
   */
  directionalBlur(angle, length, taps = 9, bias = 0) {
    if (length <= 0 || taps < 2) return this;
    const n = this.size, d = this.data;
    const out = borrow(d.length, 'dirA');
    const dx = Math.cos(angle), dy = Math.sin(angle);
    const t0 = bias >= 1 ? 0 : -0.5 * (1 - bias);
    const t1 = 0.5 + 0.5 * bias;
    let i = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, i++) {
        let sum = 0, wsum = 0;
        for (let k = 0; k < taps; k++) {
          const t = t0 + (t1 - t0) * (k / (taps - 1));
          const w = 1 - Math.abs(t) * (bias > 0 ? 0.6 : 1.2) * 0.5;
          const ww = w > 0.05 ? w : 0.05;
          sum += this.bilinear(x + dx * t * length, y + dy * t * length) * ww;
          wsum += ww;
        }
        out[i] = sum / wsum;
      }
    }
    d.set(out);
    return this;
  }

  /**
   * Sharpen / emboss-free detail boost: `this + k * (this - blur(this))`.
   * Used to bring back micro-detail after a heavy blur.
   */
  unsharp(sigma, k = 0.6) {
    const blurred = this.clone().blur(sigma);
    const a = this.data, b = blurred.data;
    for (let i = 0; i < a.length; i++) a[i] += (a[i] - b[i]) * k;
    return this;
  }

  /** Warp this field by two offset fields (in texels). Allocates one buffer. */
  warp(offsetX, offsetY, amount = 1) {
    const n = this.size, d = this.data;
    const out = borrow(d.length, 'warpA');
    const ox = offsetX.data, oy = offsetY.data;
    let i = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, i++) {
        out[i] = this.bilinear(x + ox[i] * amount, y + oy[i] * amount);
      }
    }
    d.set(out);
    return this;
  }

  /** Erode (min filter) — widens dark areas. `r` in texels. */
  erode(r = 1) { return this._morph(r, false); }
  /** Dilate (max filter) — widens bright areas. */
  dilate(r = 1) { return this._morph(r, true); }

  _morph(r, useMax) {
    r = Math.max(1, Math.round(r));
    const n = this.size, d = this.data;
    const tmp = borrow(d.length, 'morphA');
    for (let y = 0; y < n; y++) {
      const row = y * n;
      for (let x = 0; x < n; x++) {
        let best = useMax ? -Infinity : Infinity;
        for (let k = -r; k <= r; k++) {
          let xx = (x + k) % n; if (xx < 0) xx += n;
          const v = d[row + xx];
          if (useMax ? v > best : v < best) best = v;
        }
        tmp[row + x] = best;
      }
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        let best = useMax ? -Infinity : Infinity;
        for (let k = -r; k <= r; k++) {
          let yy = (y + k) % n; if (yy < 0) yy += n;
          const v = tmp[yy * n + x];
          if (useMax ? v > best : v < best) best = v;
        }
        d[y * n + x] = best;
      }
    }
    return this;
  }

  /**
   * Downsample with box averaging. `size` is snapped *down* to an exact
   * divisor of this field's size — otherwise the last partial block would be
   * dropped and the result would no longer register with (or tile like) the
   * original, which shows up as a seam after upsampling.
   */
  downsample(size) {
    const n = this.size;
    if (size >= n) return this.clone();
    const step = exactStep(n, size);
    const m = n / step;
    const out = new Field(m);
    const od = out.data, d = this.data;
    const inv = 1 / (step * step);
    for (let y = 0; y < m; y++) {
      for (let x = 0; x < m; x++) {
        let s = 0;
        for (let j = 0; j < step; j++) {
          const row = ((y * step + j) % n) * n;
          for (let i2 = 0; i2 < step; i2++) s += d[row + ((x * step + i2) % n)];
        }
        od[y * m + x] = s * inv;
      }
    }
    return out;
  }

  /** Bilinear upsample to `size`, wrapping (so it stays seamless). */
  upsample(size) {
    const out = new Field(size);
    const od = out.data;
    const s = this.size / size;
    let i = 0;
    for (let y = 0; y < size; y++) {
      const sy = (y + 0.5) * s - 0.5;
      for (let x = 0; x < size; x++, i++) {
        od[i] = this.bilinear((x + 0.5) * s - 0.5, sy);
      }
    }
    return out;
  }
}

// ── Derived maps ───────────────────────────────────────────────────────────

/**
 * Sobel-filtered tangent-space normal map from a height field.
 *
 * Convention: OpenGL-style (+Y = green points "up" in texture space), which is
 * what three.js expects. Canvas textures are uploaded with `flipY = true`, so
 * texture-space v increases as canvas y *decreases* — hence the +gy sign.
 *
 * @param {Field} height values roughly in [0,1]
 * @param {number} strength 1 = neutral; higher = more pronounced relief
 * @param {Uint8ClampedArray} [out] RGBA buffer of size*size*4
 * @returns {Uint8ClampedArray}
 */
export function heightToNormalRGBA(height, strength = 1, out) {
  const n = height.size, d = height.data;
  out = out ?? new Uint8ClampedArray(n * n * 4);
  // Scale the gradient by the resolution so `strength` means the same thing at
  // any texture size (a 1-texel step is a smaller world distance at 2048).
  const s = strength * n * 0.0125;

  for (let y = 0; y < n; y++) {
    const ym = ((y - 1) + n) % n, yp = (y + 1) % n;
    const rowC = y * n, rowM = ym * n, rowP = yp * n;
    for (let x = 0; x < n; x++) {
      const xm = ((x - 1) + n) % n, xp = (x + 1) % n;

      const h00 = d[rowM + xm], h10 = d[rowM + x], h20 = d[rowM + xp];
      const h01 = d[rowC + xm], h21 = d[rowC + xp];
      const h02 = d[rowP + xm], h12 = d[rowP + x], h22 = d[rowP + xp];

      const gx = (h20 + 2 * h21 + h22) - (h00 + 2 * h01 + h02);
      const gy = (h02 + 2 * h12 + h22) - (h00 + 2 * h10 + h20);

      let nx = -gx * s;
      let ny = gy * s;
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv; ny *= inv;

      const i = (rowC + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Cheap multi-tap ambient occlusion from a height field.
 *
 * For each texel we shoot `dirs` rays outward, sample `steps` points along
 * each and keep the maximum elevation angle (a horizon-based estimate). The
 * whole thing runs at a reduced resolution — AO is low frequency, nobody can
 * tell — then gets upsampled and lightly blurred.
 *
 * @param {Field} height
 * @param {object} [o]
 * @param {number} [o.radius] search radius as a fraction of the tile (0..0.5)
 * @param {number} [o.strength] 0..1.5
 * @param {number} [o.dirs]
 * @param {number} [o.steps]
 * @param {number} [o.heightScale] how tall the height field is relative to the tile
 * @param {number} [o.res] working resolution cap
 * @returns {Field} occlusion factor in [0,1] (1 = fully open)
 */
export function heightToAO(height, o = {}) {
  const radius = o.radius ?? 0.045;
  const strength = o.strength ?? 1;
  const dirs = o.dirs ?? 8;
  const steps = o.steps ?? 4;
  const heightScale = o.heightScale ?? 0.35;
  const res = Math.min(height.size, o.res ?? 192);

  const src = height.size > res ? height.downsample(res) : height;
  const upTo = height.size;
  const n = src.size;
  const out = new Field(n);
  const od = out.data, sd = src.data;
  const rPx = Math.max(1.5, radius * n);

  // Precompute ray directions (cosine-ish distributed, rotated per texel by a
  // cheap hash to break banding).
  const cs = new Float32Array(dirs * 2);
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    cs[k * 2] = Math.cos(a);
    cs[k * 2 + 1] = Math.sin(a);
  }

  let i = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++, i++) {
      const h0 = sd[i];
      // Per-texel rotation of the ray fan.
      const jitter = (((x * 7 + y * 13) & 7) / 8) * (Math.PI * 2 / dirs);
      const cj = Math.cos(jitter), sj = Math.sin(jitter);
      let occ = 0;
      for (let k = 0; k < dirs; k++) {
        const dx0 = cs[k * 2], dy0 = cs[k * 2 + 1];
        const dx = dx0 * cj - dy0 * sj;
        const dy = dx0 * sj + dy0 * cj;
        let maxSlope = 0;
        for (let s = 1; s <= steps; s++) {
          const t = (s / steps) * rPx;
          const hs = src.bilinear(x + dx * t, y + dy * t);
          const dh = (hs - h0) * heightScale * n;
          const slope = dh / t;
          if (slope > maxSlope) maxSlope = slope;
        }
        // Horizon angle → occluded fraction of the hemisphere in that direction.
        occ += maxSlope / Math.sqrt(1 + maxSlope * maxSlope);
      }
      occ /= dirs;
      od[i] = 1 - Math.min(1, occ * strength);
    }
  }

  out.blur(1.2);
  return out.size === upTo ? out : out.upsample(upTo);
}

/**
 * Curvature / cavity map: positive on ridges, negative in creases. Useful for
 * edge wear, dust settling and grime masks.
 * @returns {Field} in roughly [-1,1]
 */
export function heightToCurvature(height, sigma = 2.5, gain = 6) {
  const blurred = height.clone().blur(sigma);
  const out = new Field(height.size);
  const a = height.data, b = blurred.data, o = out.data;
  for (let i = 0; i < a.length; i++) {
    o[i] = Math.max(-1, Math.min(1, (a[i] - b[i]) * gain));
  }
  return out;
}

/**
 * "Where would dust settle?" mask — flat, low, concave areas score high.
 * @returns {Field} [0,1]
 */
export function dustMask(height, sigma = 3) {
  const curv = heightToCurvature(height, sigma, 5);
  const out = new Field(height.size);
  const c = curv.data, h = height.data, o = out.data;
  for (let i = 0; i < c.length; i++) {
    const cavity = Math.max(0, -c[i]);
    const low = 1 - h[i];
    o[i] = Math.min(1, cavity * 0.75 + low * 0.45);
  }
  return out.blur(1.5);
}
