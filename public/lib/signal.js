// @ts-check
/**
 * Synthetic receiver: produces FFT frames in dB (roughly -130..0) so the test
 * interface has something to show without a radio attached.
 */

/**
 * @typedef {object} Carrier
 * @property {number} at      position as a fraction of the span (0..1)
 * @property {number} level   peak level in dB
 * @property {number} width   -3 dB half-width in bins
 * @property {number} [pulse] on/off period in ms (0 = always on)
 */

/**
 * @typedef {object} SignalOptions
 * @property {number} bins
 * @property {number} noiseFloor   mean noise level, dB
 * @property {number} noise        noise spread, dB
 * @property {Carrier[]} carriers
 * @property {boolean} sweep       add a carrier sweeping across the span
 * @property {number} sweepPeriod  ms for one sweep
 */

/** @type {SignalOptions} */
export const DEFAULT_SIGNAL = {
  bins: 1024,
  noiseFloor: -105,
  noise: 6,
  carriers: [
    { at: 0.18, level: -42, width: 1.5 },
    { at: 0.36, level: -68, width: 6 },
    { at: 0.5, level: -30, width: 2.5 },
    { at: 0.64, level: -55, width: 1, pulse: 900 },
    { at: 0.82, level: -75, width: 18 },
  ],
  sweep: true,
  sweepPeriod: 12000,
};

/** Deterministic PRNG (mulberry32). @param {number} seed */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Power-sum two dB levels.
 * @param {number} a @param {number} b
 */
export function addDb(a, b) {
  return 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10));
}

/**
 * Level of a carrier shape at a distance from its centre (Gaussian in dB).
 * @param {number} level @param {number} width @param {number} distance
 */
export function carrierShape(level, width, distance) {
  const w = Math.max(width, 0.25);
  return level - 3 * (distance / w) ** 2;
}

/**
 * @param {Partial<SignalOptions>} [options]
 * @param {number} [seed]
 */
export function createSignal(options = {}, seed = 1) {
  /** @type {SignalOptions} */
  const opts = { ...DEFAULT_SIGNAL, ...options };
  const rand = mulberry32(seed);

  /**
   * Generate one frame.
   * @param {number} tMs time in ms (drives sweep and pulsing)
   * @returns {Float32Array}
   */
  function next(tMs) {
    const n = Math.max(1, Math.floor(opts.bins));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Sum of uniforms ~ normal; |noise| keeps the floor ragged like real FFTs.
      const g = (rand() + rand() + rand() + rand() - 2) / 0.577;
      out[i] = opts.noiseFloor + g * opts.noise * 0.5;
    }

    const shapes = opts.carriers
      .filter((c) => !c.pulse || Math.floor(tMs / c.pulse) % 2 === 0)
      .map((c) => ({ centre: c.at * (n - 1), level: c.level, width: c.width * n / 1024 }));
    if (opts.sweep) {
      const phase = (tMs % opts.sweepPeriod) / opts.sweepPeriod;
      shapes.push({ centre: phase * (n - 1), level: -60, width: 1.2 * n / 1024 });
    }

    for (const s of shapes) {
      const reach = Math.ceil(s.width * 6);
      const lo = Math.max(0, Math.floor(s.centre - reach));
      const hi = Math.min(n - 1, Math.ceil(s.centre + reach));
      for (let i = lo; i <= hi; i++) {
        out[i] = addDb(out[i], carrierShape(s.level, s.width, i - s.centre));
      }
    }

    for (let i = 0; i < n; i++) out[i] = Math.min(0, Math.max(-140, out[i]));
    return out;
  }

  return {
    next,
    get options() {
      return opts;
    },
    /** @param {Partial<SignalOptions>} patch */
    configure(patch) {
      Object.assign(opts, patch);
    },
  };
}
