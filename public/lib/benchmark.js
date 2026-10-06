// @ts-check
/**
 * Side-by-side timing of two Spectrum implementations. Environment-agnostic:
 * the caller supplies factories, so this runs in the browser against real
 * canvases and in Deno against mocks.
 */

/**
 * @typedef {object} BenchCase
 * @property {string} name
 * @property {() => any} create         returns a fresh Spectrum instance
 */

/**
 * @typedef {object} BenchResult
 * @property {string} name
 * @property {number} addDataMs     mean ms per addData() frame
 * @property {number} waterfallMs   mean ms per rowToImageData() call
 */

/**
 * Cases are interleaved over several rounds (A, B, A, B, ...) and the best
 * round is kept, so warm-up costs such as first-use canvas allocation or JIT
 * tier-up don't penalise whichever implementation happens to run first.
 *
 * @param {BenchCase[]} cases
 * @param {ArrayLike<number>[]} frames  input frames, cycled
 * @param {{ iterations?: number, warmup?: number, rounds?: number, now?: () => number }} [opts]
 * @returns {BenchResult[]}
 */
export function runBenchmark(cases, frames, opts = {}) {
  const iterations = opts.iterations ?? 200;
  const warmup = opts.warmup ?? 20;
  const rounds = Math.max(1, opts.rounds ?? 3);
  const now = opts.now ?? (() => performance.now());
  if (!frames.length) throw new RangeError("runBenchmark: no frames");

  const instances = cases.map(({ create }) => {
    const sp = create();
    sp.setAveraging(4);
    sp.setMaxHold(true);
    for (let i = 0; i < warmup; i++) sp.addData(frames[i % frames.length]);
    return sp;
  });
  const best = cases.map(({ name }) => ({ name, addDataMs: Infinity, waterfallMs: Infinity }));

  for (let r = 0; r < rounds; r++) {
    instances.forEach((sp, k) => {
      let t0 = now();
      for (let i = 0; i < iterations; i++) sp.addData(frames[i % frames.length]);
      best[k].addDataMs = Math.min(best[k].addDataMs, (now() - t0) / iterations);

      t0 = now();
      for (let i = 0; i < iterations; i++) sp.rowToImageData(frames[i % frames.length]);
      best[k].waterfallMs = Math.min(best[k].waterfallMs, (now() - t0) / iterations);
    });
  }
  return best;
}

/**
 * Relative speed of `b` vs `a` (>1 means b is faster).
 * @param {number} a @param {number} b
 */
export function speedup(a, b) {
  return b > 0 ? a / b : Infinity;
}
