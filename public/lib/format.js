// @ts-check
/** Formatting and small measurement helpers for the status bar. */

/**
 * Human-readable frequency.
 * @param {number} hz
 * @param {number} [digits]
 */
export function formatHz(hz, digits = 3) {
  if (!Number.isFinite(hz)) return "—";
  const a = Math.abs(hz);
  if (a >= 1e9) return `${(hz / 1e9).toFixed(digits)} GHz`;
  if (a >= 1e6) return `${(hz / 1e6).toFixed(digits)} MHz`;
  if (a >= 1e3) return `${(hz / 1e3).toFixed(digits)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

/** @param {number} min @param {number} max */
export function formatDbRange(min, max) {
  return `${min} … ${max} dB`;
}

/** @param {number} ms */
export function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(2)} ms`;
}

/** Fixed-window rolling mean. */
export class Rolling {
  /** @param {number} size */
  constructor(size) {
    this.size = Math.max(1, size | 0);
    /** @type {number[]} */
    this.values = [];
    this.sum = 0;
  }

  /** @param {number} v */
  push(v) {
    this.values.push(v);
    this.sum += v;
    if (this.values.length > this.size) this.sum -= /** @type {number} */ (this.values.shift());
    return this;
  }

  get mean() {
    return this.values.length ? this.sum / this.values.length : NaN;
  }

  reset() {
    this.values = [];
    this.sum = 0;
  }
}

/** Frames-per-second from frame timestamps. */
export class FpsMeter {
  /** @param {number} [window] number of intervals averaged */
  constructor(window = 30) {
    this.intervals = new Rolling(window);
    /** @type {number | undefined} */
    this.last = undefined;
  }

  /** @param {number} now ms */
  tick(now) {
    if (this.last !== undefined) this.intervals.push(now - this.last);
    this.last = now;
  }

  get fps() {
    const m = this.intervals.mean;
    return Number.isFinite(m) && m > 0 ? 1000 / m : 0;
  }

  reset() {
    this.intervals.reset();
    this.last = undefined;
  }
}
