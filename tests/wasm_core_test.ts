/**
 * Unit tests for each wasm kernel, checked against the JavaScript expression
 * it replaces in the original spectrum.js.
 */

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { newCore, wasmModuleBytes } from "./helpers/load.ts";
import { prng } from "./helpers/mock_dom.ts";
import { base64ToBytes, createSpectrumCore, createSpectrumCoreAsync } from "../src/wasm_core.js";

const core = newCore();

// ---- module / memory ----------------------------------------------------

Deno.test("module: has no imports", () => {
  const mod = new WebAssembly.Module(wasmModuleBytes() as BufferSource);
  assertEquals(WebAssembly.Module.imports(mod), []);
});

Deno.test("module: exports every kernel the host uses", () => {
  const mod = new WebAssembly.Module(wasmModuleBytes() as BufferSource);
  const names = WebAssembly.Module.exports(mod).map((e) => e.name).sort();
  for (
    const n of [
      "memory",
      "alloc",
      "dealloc",
      "js_round",
      "squeeze",
      "row_to_rgba",
      "average_update",
      "max_hold_update",
      "min_hold_update",
      "fft_path_y",
      "axis_increment",
      "hz_to_bin",
      "bin_to_hz",
      "pixel_to_bin",
      "limit_cursor",
      "filter_rect",
      "array_max",
      "array_min",
    ]
  ) {
    assert(names.includes(n), `missing export ${n}`);
  }
});

Deno.test("module: stays small enough for synchronous compilation", () => {
  assert(wasmModuleBytes().byteLength < 64 * 1024);
});

Deno.test("alloc: returns 8-byte aligned, distinct blocks", () => {
  const ex = core.ex;
  const a = ex.alloc(24);
  const b = ex.alloc(24);
  assert(a !== 0 && b !== 0);
  assertEquals(a % 8, 0);
  assertEquals(b % 8, 0);
  assert(a !== b);
  ex.dealloc(a, 24);
  ex.dealloc(b, 24);
});

Deno.test("alloc: freed block is reused for the same size", () => {
  const ex = core.ex;
  const a = ex.alloc(1000);
  ex.dealloc(a, 1000);
  const b = ex.alloc(1000);
  assertEquals(b, a);
  ex.dealloc(b, 1000);
});

Deno.test("alloc: grows linear memory for large buffers", () => {
  const c = newCore();
  const before = c.memoryBytes;
  const big = new Float64Array(200_000).fill(-50);
  c.arrayMax(big);
  assert(c.memoryBytes > before);
});

Deno.test("alloc: results remain correct after memory growth mid-call", () => {
  const c = newCore();
  const small = [1, 2, 3];
  const avg = new Float64Array([0, 0, 0]);
  c.averageUpdate(avg, small, 0.5);
  // Force growth through the state buffer while bins sit in another block.
  const n = 300_000;
  const bins = new Float64Array(n).fill(10);
  const state = new Float64Array(n).fill(0);
  c.averageUpdate(state, bins, 0.5);
  assertEquals(state[0], 5);
  assertEquals(state[n - 1], 5);
});

// ---- JS Math semantics --------------------------------------------------

Deno.test("js_round: matches Math.round on edge cases", () => {
  const cases = [
    0,
    -0,
    0.5,
    -0.5,
    1.5,
    -1.5,
    2.5,
    -2.5,
    0.49999999999999994,
    -0.49999999999999994,
    4503599627370495.5,
    -4503599627370495.5,
    1e300,
    -1e300,
    Infinity,
    -Infinity,
    NaN,
    123.456,
    -123.456,
  ];
  for (const x of cases) assertEquals(core.round(x), Math.round(x), `round(${x})`);
});

Deno.test("js_round: matches Math.round on random inputs", () => {
  const r = prng(1);
  for (let i = 0; i < 5000; i++) {
    const x = (r() - 0.5) * 10 ** Math.floor(r() * 12);
    assertEquals(core.round(x), Math.round(x));
  }
});

Deno.test("js_floor / js_ceil: match Math on random and edge inputs", () => {
  const r = prng(2);
  const cases = [0, -0, 0.1, -0.1, 1, -1, 2 ** 53, -(2 ** 53), Infinity, -Infinity, NaN];
  for (let i = 0; i < 3000; i++) cases.push((r() - 0.5) * 10 ** Math.floor(r() * 16));
  for (const x of cases) {
    assertEquals(core.floor(x), Math.floor(x), `floor(${x})`);
    assertEquals(core.ceil(x), Math.ceil(x), `ceil(${x})`);
  }
});

Deno.test("arrayMax / arrayMin: match Math.max/min spread", () => {
  const r = prng(3);
  const arr = Array.from({ length: 4096 }, () => -130 + r() * 140);
  assertEquals(core.arrayMax(arr), Math.max(...arr));
  assertEquals(core.arrayMin(arr), Math.min(...arr));
});

Deno.test("arrayMax / arrayMin: empty arrays", () => {
  assertEquals(core.arrayMax([]), -Infinity);
  assertEquals(core.arrayMin([]), Infinity);
});

Deno.test("arrayMax / arrayMin: NaN propagates", () => {
  assertEquals(core.arrayMax([1, NaN, 3]), NaN);
  assertEquals(core.arrayMin([1, NaN, 3]), NaN);
});

Deno.test("arrayMax / arrayMin: signed zero ordering", () => {
  assert(Object.is(core.arrayMax([-0, 0]), 0));
  assert(Object.is(core.arrayMin([0, -0]), -0));
});

Deno.test("arrayMax: works on 1M elements (original spread would overflow)", () => {
  const big = new Float64Array(1_000_000).fill(-90);
  big[777_777] = -3;
  assertEquals(core.arrayMax(big), -3);
});

// ---- squeeze ------------------------------------------------------------

function jsSqueeze(v: number, omin: number, omax: number, min: number, max: number) {
  if (v <= min) return omin;
  else if (v >= max) return omax;
  return Math.round((v - min) / (max - min) * omax);
}

Deno.test("squeeze: clamps below min_db", () => {
  assertEquals(core.squeeze(-130, 7, 255, -120, 0), 7);
  assertEquals(core.squeeze(-120, 7, 255, -120, 0), 7);
});

Deno.test("squeeze: clamps above max_db", () => {
  assertEquals(core.squeeze(5, 0, 255, -120, 0), 255);
  assertEquals(core.squeeze(0, 0, 255, -120, 0), 255);
});

Deno.test("squeeze: interpolates and rounds like Math.round", () => {
  const r = prng(4);
  for (let i = 0; i < 5000; i++) {
    const v = -150 + r() * 170;
    assertEquals(core.squeeze(v, 0, 600, -120, 0), jsSqueeze(v, 0, 600, -120, 0));
  }
});

Deno.test("squeeze: NaN value falls through to interpolation (NaN)", () => {
  assertEquals(core.squeeze(NaN, 0, 255, -120, 0), jsSqueeze(NaN, 0, 255, -120, 0));
});

// ---- colormap / waterfall row -------------------------------------------

const CMAP3 = [[10, 20, 30], [40, 50, 60], [70, 80, 90]];

Deno.test("colormapIndex: endpoints and midpoint", () => {
  assertEquals(core.colormapIndex(-120, 3, -120, 0), 0);
  assertEquals(core.colormapIndex(0, 3, -120, 0), 2);
  assertEquals(core.colormapIndex(-60, 3, -120, 0), 1);
});

Deno.test("colormapIndex: clamps out-of-range bins", () => {
  assertEquals(core.colormapIndex(-500, 256, -120, 0), 0);
  assertEquals(core.colormapIndex(500, 256, -120, 0), 255);
  assertEquals(core.colormapIndex(Infinity, 256, -120, 0), 255);
  assertEquals(core.colormapIndex(-Infinity, 256, -120, 0), 0);
});

Deno.test("colormapIndex: NaN maps to the last entry (original catch path)", () => {
  assertEquals(core.colormapIndex(NaN, 64, -120, 0), 63);
});

Deno.test("colormapIndex: degenerate range (min == max)", () => {
  // (v - m) / 0 -> +/-Infinity -> clamped; 0/0 -> NaN -> last entry.
  assertEquals(core.colormapIndex(-40, 10, -50, -50), 9);
  assertEquals(core.colormapIndex(-60, 10, -50, -50), 0);
  assertEquals(core.colormapIndex(-50, 10, -50, -50), 9);
});

Deno.test("rowToRgba: writes RGBA with opaque alpha", () => {
  const c = newCore();
  c.setColormap(CMAP3);
  const out = Array.from(c.rowToRgba([-120, -60, 0], -120, 0));
  assertEquals(out, [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
});

Deno.test("rowToRgba: honours waterfall range independently of spectrum range", () => {
  const c = newCore();
  c.setColormap(CMAP3);
  const out = Array.from(c.rowToRgba([-80, -60, -40], -80, -40));
  assertEquals(out, [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
});

Deno.test("rowToRgba: matches the original per-pixel algorithm on random data", () => {
  const c = newCore();
  const r = prng(5);
  const cmap = Array.from({ length: 200 }, () => [r() * 255 | 0, r() * 255 | 0, r() * 255 | 0]);
  c.setColormap(cmap);
  const bins = Array.from({ length: 2048 }, () => -140 + r() * 160);
  const got = c.rowToRgba(bins, -110, -10);
  for (let i = 0; i < bins.length; i++) {
    let scaled = (bins[i] - -110) / (-10 - -110);
    if (scaled > 1) scaled = 1;
    if (scaled < 0) scaled = 0;
    const col = cmap[Math.round((cmap.length - 1) * scaled)];
    assertEquals([got[i * 4], got[i * 4 + 1], got[i * 4 + 2], got[i * 4 + 3]], [...col, 255]);
  }
});

Deno.test("setColormap: coerces like Uint8ClampedArray", () => {
  const c = newCore();
  c.setColormap([[-5, 300, 2.5], [3.5, 127.5, 128.5]]);
  const out = Array.from(c.rowToRgba([-120, 0], -120, 0));
  assertEquals(out, [0, 255, 2, 255, 4, 128, 128, 255]);
});

Deno.test("setColormap: caches by identity, re-uploads on new array", () => {
  const c = newCore();
  const a = [[1, 1, 1], [2, 2, 2]];
  c.setColormap(a);
  a[0] = [9, 9, 9]; // in-place edit is not seen until invalidated
  assertEquals(Array.from(c.rowToRgba([-120], -120, 0)), [1, 1, 1, 255]);
  c.invalidateColormap();
  c.setColormap(a);
  assertEquals(Array.from(c.rowToRgba([-120], -120, 0)), [9, 9, 9, 255]);
  c.setColormap([[5, 5, 5]]);
  assertEquals(Array.from(c.rowToRgba([-120], -120, 0)), [5, 5, 5, 255]);
});

Deno.test("setColormap: re-uploads when the same array changes length", () => {
  const c = newCore();
  const a = [[1, 1, 1], [2, 2, 2]];
  c.setColormap(a);
  a.push([3, 3, 3]);
  c.setColormap(a);
  assertEquals(Array.from(c.rowToRgba([0], -120, 0)), [3, 3, 3, 255]);
});

// ---- averaging / hold ---------------------------------------------------

Deno.test("averageUpdate: exponential moving average", () => {
  const avg = new Float64Array([0, 10, -10]);
  core.averageUpdate(avg, [10, 10, 10], 0.25);
  assertEquals(Array.from(avg), [2.5, 10, -5]);
});

Deno.test("averageUpdate: bit-identical to the JS loop", () => {
  const r = prng(6);
  const avgW = new Float64Array(Array.from({ length: 1024 }, () => -100 + r() * 50));
  const avgJ = Array.from(avgW);
  const alpha = 2 / (7 + 1);
  for (let f = 0; f < 20; f++) {
    const bins = Array.from({ length: 1024 }, () => -120 + r() * 120);
    core.averageUpdate(avgW, bins, alpha);
    for (let i = 0; i < bins.length; i++) avgJ[i] += alpha * (bins[i] - avgJ[i]);
  }
  assertEquals(Array.from(avgW), avgJ);
});

Deno.test("averageUpdate: works on a plain Array target", () => {
  const avg = [0, 0];
  core.averageUpdate(avg, [4, 8], 0.5);
  assertEquals(avg, [2, 4]);
});

Deno.test("maxHoldUpdate: keeps peaks", () => {
  const m = new Float64Array([-50, -50]);
  core.maxHoldUpdate(m, [-40, -60], 1);
  assertEquals(Array.from(m), [-40, -50]);
});

Deno.test("maxHoldUpdate: decay multiplies held values (original semantics)", () => {
  const m = new Float64Array([-50, -50]);
  core.maxHoldUpdate(m, [-40, -60], 0.9);
  // -50 * 0.9 = -45: with negative dB values decay *raises* the trace,
  // exactly as the original does.
  assertEquals(Array.from(m), [-40, -45]);
});

Deno.test("maxHoldUpdate: equal value is treated as not-greater (decays)", () => {
  const m = new Float64Array([-50]);
  core.maxHoldUpdate(m, [-50], 0.5);
  assertEquals(m[0], -25);
});

Deno.test("minHoldUpdate: keeps troughs, never decays", () => {
  const m = new Float64Array([-50, -50]);
  core.minHoldUpdate(m, [-40, -60]);
  assertEquals(Array.from(m), [-50, -60]);
});

Deno.test("hold updates: NaN input bins leave held values unchanged/decayed", () => {
  const max = new Float64Array([-50]);
  const min = new Float64Array([-50]);
  core.maxHoldUpdate(max, [NaN], 0.5);
  core.minHoldUpdate(min, [NaN]);
  assertEquals(max[0], -25);
  assertEquals(min[0], -50);
});

// ---- geometry -----------------------------------------------------------

Deno.test("dbToY: top, bottom and middle of spectrum area", () => {
  assertEquals(core.dbToY(0, -120, 0, 300), 0);
  assertEquals(core.dbToY(-120, -120, 0, 300), 300);
  assertEquals(core.dbToY(-60, -120, 0, 300), 150);
});

Deno.test("fftPathY: matches the drawFFT expression for each bin", () => {
  const r = prng(7);
  const bins = Array.from({ length: 777 }, () => -130 + r() * 140);
  const ys = core.fftPathY(bins, -110, -5, 321);
  const dbm = 321 / (-5 - -110);
  for (let i = 0; i < bins.length; i++) {
    let s = (bins[i] - -110) * dbm;
    s = 321 - s;
    assertEquals(ys[i], s);
  }
});

Deno.test("fftPathY: empty input", () => {
  assertEquals(core.fftPathY([], -120, 0, 100).length, 0);
});

Deno.test("filterRect: matches drawFilter", () => {
  const [x, w] = core.filterRect(10_100_000, 9_488_000, -3000, 3000, 1000);
  assertAlmostEquals(x, 609, 1e-9);
  assertAlmostEquals(w, 6, 1e-9);
});

// ---- axis ---------------------------------------------------------------

Deno.test("axisIncrement: table values", () => {
  const table: [number, number][] = [
    [40, 5000],
    [80, 10000],
    [200, 50000],
    [400, 50000],
    [800, 100000],
    [1000, 200000],
    [2000, 500000],
    [4000, 1000000],
    [8000, 1000000],
    [16000, 2000000],
    [20000, 2000000],
  ];
  for (const [ratio, inc] of table) assertEquals(core.axisIncrement(ratio * 1024, 1024), inc);
});

Deno.test("axisIncrement: default is 100x Hz/bin", () => {
  assertEquals(core.axisIncrement(123 * 1000, 1000), 12300);
});

Deno.test("axisIncrement: NaN (no bins yet) falls back to 2 MHz", () => {
  assertEquals(core.axisIncrement(1_000_000, NaN), 2_000_000);
  assertEquals(core.axisIncrement(0, 0), 2_000_000);
});

Deno.test("axisIncrement: zero span with bins gives zero", () => {
  assertEquals(core.axisIncrement(0, 1024), 0);
});

Deno.test("axisFirstTick: matches JS remainder semantics", () => {
  for (const [s, inc] of [[9_488_000, 100_000], [-1_250_000, 500_000], [0, 1]]) {
    assertEquals(core.axisFirstTick(s, inc), s - (s % inc));
  }
});

// ---- autoscale ----------------------------------------------------------

Deno.test("autoscaleFloor / autoscaleCeil: 5 dB steps", () => {
  assertEquals(core.autoscaleFloor(-97.3, 5), -100);
  assertEquals(core.autoscaleCeil(-12.1, 5), -10);
  assertEquals(core.autoscaleFloor(-95, 5), -95);
  assertEquals(core.autoscaleCeil(-10, 5), -10);
  assert(Object.is(core.autoscaleCeil(-0.5, 5), -0));
});

// ---- conversions --------------------------------------------------------

Deno.test("hzToBin / binToHz: round trip on bin centres", () => {
  for (let bin = 0; bin < 1024; bin += 37) {
    const hz = core.binToHz(bin, 10_000_000, 1_024_000, 1024);
    assertEquals(core.hzToBin(hz + 1, 10_000_000, 1_024_000, 1024), bin);
  }
});

Deno.test("pixelToBin: floors", () => {
  assertEquals(core.pixelToBin(511.9, 1024, 1024), 511);
  assertEquals(core.pixelToBin(-0.1, 1024, 1024), -1);
});

Deno.test("limitCursor: clamps into the displayed span", () => {
  assertEquals(core.limitCursor(1, 10_000_000, 1_000_000), 9_500_000);
  assertEquals(core.limitCursor(99e6, 10_000_000, 1_000_000), 10_500_000);
  assertEquals(core.limitCursor(10_123_456, 10_000_000, 1_000_000), 10_123_456);
});

Deno.test("limitCursor: NaN propagates like Math.min/Math.max", () => {
  assertEquals(core.limitCursor(NaN, 10_000_000, 1_000_000), NaN);
});

// ---- instantiation helpers ----------------------------------------------

Deno.test("createSpectrumCore: accepts a compiled Module", () => {
  const mod = new WebAssembly.Module(wasmModuleBytes() as BufferSource);
  assertEquals(createSpectrumCore(mod).round(1.5), 2);
});

Deno.test("createSpectrumCoreAsync: accepts bytes", async () => {
  const c = await createSpectrumCoreAsync(wasmModuleBytes() as BufferSource);
  assertEquals(c.round(2.5), 3);
});

Deno.test("createSpectrumCoreAsync: accepts a Response", async () => {
  const res = new Response(wasmModuleBytes() as BodyInit, {
    headers: { "content-type": "application/wasm" },
  });
  const c = await createSpectrumCoreAsync(res);
  assertEquals(c.round(-2.5), -2);
});

Deno.test("createSpectrumCoreAsync: rejects on HTTP error", async () => {
  let threw = false;
  try {
    await createSpectrumCoreAsync(new Response("nope", { status: 404 }));
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("createSpectrumCore: rejects invalid bytes", () => {
  assertThrows(() => createSpectrumCore(new Uint8Array([1, 2, 3, 4])));
});

Deno.test("base64ToBytes: decodes", () => {
  assertEquals(Array.from(base64ToBytes("AGFzbQ==")), [0, 0x61, 0x73, 0x6d]);
});
