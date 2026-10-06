// deno-lint-ignore-file no-console -- these tests stub console.error
/**
 * Unit tests for the wasm Spectrum class itself: behaviour that is specific to
 * the port (deliberate differences, readiness, core sharing) plus focused
 * checks of individual prototype methods.
 */

import { assert, assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { MockDocument, prng, randomBins } from "./helpers/mock_dom.ts";
import { defaultColormaps, loadWasm, newCore } from "./helpers/load.ts";
import { defineSpectrum } from "../src/spectrum.js";

const COLORMAPS = defaultColormaps();
const RADIO = { centerHz: 10_000_000, spanHz: 1_024_000, bins: 1024 };

function make(options: Record<string, unknown> = RADIO, size: [number, number] = [1024, 600]) {
  const doc = new MockDocument("waterfall", size[0], size[1]);
  const Spectrum = loadWasm({ document: doc, colormaps: COLORMAPS });
  return { sp: new Spectrum("waterfall", options), doc, Spectrum };
}

Deno.test("Spectrum: throws a clear error when the core is not ready", () => {
  const doc = new MockDocument();
  // deno-lint-ignore no-explicit-any
  const Spectrum = defineSpectrum({ core: null }, { document: doc, colormaps: COLORMAPS } as any);
  assertThrows(() => new Spectrum("waterfall", RADIO), Error, "not ready");
});

Deno.test("Spectrum: core supplied after definition is picked up", () => {
  const doc = new MockDocument();
  const ref: { core: ReturnType<typeof newCore> | null } = { core: null };
  // deno-lint-ignore no-explicit-any
  const Spectrum = defineSpectrum(ref, { document: doc, colormaps: COLORMAPS } as any);
  ref.core = newCore();
  const sp = new Spectrum("waterfall", RADIO);
  assertEquals(sp.min_db, -120);
});

Deno.test("Spectrum: multiple instances can share one core", () => {
  const core = newCore();
  const docA = new MockDocument();
  const docB = new MockDocument();
  const A = loadWasm({ document: docA, colormaps: COLORMAPS }, core);
  const B = loadWasm({ document: docB, colormaps: COLORMAPS }, core);
  const a = new A("waterfall", RADIO);
  const b = new B("waterfall", RADIO);
  a.setMaxHold(true);
  b.setMaxHold(true);
  const r = prng(1);
  const fa = randomBins(1024, r);
  const fb = randomBins(1024, r);
  a.addData(fa);
  b.addData(fb);
  a.addData(fb);
  b.addData(fa);
  assertEquals(Array.from(a.binsMax), Array.from(b.binsMax));
});

Deno.test("Spectrum: colormaps global is read lazily (late-loaded colormaps)", () => {
  const doc = new MockDocument();
  const host: { document: MockDocument; colormaps: number[][][] } = {
    document: doc,
    colormaps: [[[1, 2, 3]]],
  };
  const Spectrum = loadWasm(host);
  const sp = new Spectrum("waterfall", RADIO);
  host.colormaps = COLORMAPS;
  sp.setColormap(2);
  assertEquals(sp.colormap, COLORMAPS[2]);
});

Deno.test("binsAverage/binsMax/binsMin are Float64Array", () => {
  const { sp } = make();
  sp.setAveraging(3);
  sp.setMaxHold(true);
  sp.addData(randomBins(1024, prng(2)));
  assertInstanceOf(sp.binsAverage, Float64Array);
  assertInstanceOf(sp.binsMax, Float64Array);
  assertInstanceOf(sp.binsMin, Float64Array);
});

Deno.test("binsMax keeps identity across frames (references stay live)", () => {
  const { sp } = make();
  sp.setMaxHold(true);
  sp.addData(randomBins(1024, prng(3)));
  const ref = sp.binsMax;
  sp.addData(randomBins(1024, prng(4)));
  assert(sp.binsMax === ref);
});

Deno.test("autoscale with max hold before the first frame does not throw", () => {
  const { sp } = make();
  sp.setMaxHold(true);
  sp.forceAutoscale();
  sp.addData([-100, -50, -20]);
  assertEquals([sp.min_db, sp.max_db], [-100, -20]);
});

Deno.test("autoscale: sets spectrum and waterfall range in 5 dB steps", () => {
  const { sp } = make();
  sp.forceAutoscale();
  sp.addData([-97, -63, -12]);
  assertEquals([sp.min_db, sp.max_db, sp.wf_min_db, sp.wf_max_db], [-100, -10, -100, -10]);
  assertEquals(sp.autoscale, false);
});

Deno.test("rowToImageData: NaN bins don't log and paint last colour", () => {
  const { sp } = make();
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    sp.addData([NaN, NaN]);
  } finally {
    console.error = orig;
  }
  assertEquals(errors.length, 0);
  const last = sp.colormap[sp.colormap.length - 1];
  assertEquals(Array.from(sp.imagedata.data.slice(0, 4)), [...last, 255]);
});

Deno.test("rowToImageData: empty colormap throws a TypeError", () => {
  const { sp } = make();
  sp.colormap = [];
  assertThrows(() => sp.addData([-50]), TypeError);
});

Deno.test("rowToImageData: shorter bins than image pads like undefined (NaN)", () => {
  const { sp } = make();
  sp.addData([-120, -120, -120, -120]);
  sp.rowToImageData([-120, -120]);
  const last = sp.colormap[sp.colormap.length - 1];
  assertEquals(Array.from(sp.imagedata.data.slice(8, 12)), [...last, 255]);
});

Deno.test("togglePaused: updates the pause button label", () => {
  const { sp, doc } = make();
  sp.togglePaused();
  assertEquals(doc.el("pause").textContent, "Run");
  sp.togglePaused();
  assertEquals(doc.el("pause").textContent, "Pause");
});

Deno.test("toggleMaxHold: updates label and resets holds", () => {
  const { sp, doc } = make();
  sp.toggleMaxHold();
  sp.addData(randomBins(1024, prng(5)));
  assert(sp.binsMax);
  sp.toggleMaxHold();
  assertEquals(doc.el("max_hold").textContent, "Max hold");
  assertEquals(sp.binsMax, undefined);
  assertEquals(sp.binsMin, undefined);
});

Deno.test("toggleColor: wraps and updates the colormap select", () => {
  const { sp, doc } = make();
  for (let i = 0; i < COLORMAPS.length; i++) sp.toggleColor();
  assertEquals(sp.colorindex, 0);
  assertEquals(doc.el("colormap").value, 0);
});

Deno.test("toggleFullscreen: requests then exits", () => {
  const { sp, doc } = make();
  sp.toggleFullscreen();
  assertEquals(doc.mainCanvas.fullscreenRequests, 1);
  assertEquals(sp.fullscreen, true);
  sp.toggleFullscreen();
  assertEquals(doc.exitFullscreenCalls, 1);
  assertEquals(sp.fullscreen, false);
});

Deno.test("setAveraging: negative values are ignored", () => {
  const { sp } = make();
  sp.setAveraging(4);
  sp.setAveraging(-1);
  assertEquals(sp.averaging, 4);
  assertEquals(sp.alpha, 2 / 5);
});

Deno.test("spectrum hidden (0%) skips drawing but still updates holds", () => {
  const { sp, doc } = make();
  sp.setMaxHold(true);
  sp.setSpectrumPercent(0);
  // Axes height follows in resize() at the end of the frame (as in the
  // original), so hiding takes effect from the next frame.
  sp.addData(randomBins(1024, prng(6)));
  doc.log.length = 0;
  sp.addData(randomBins(1024, prng(6)));
  assert(sp.binsMax);
  assert(!doc.log.some((e) => e[0] === "main.stroke"));
});

Deno.test("resize: picks up new client size and recomputes spectrum height", () => {
  const { sp, doc } = make();
  doc.mainCanvas.clientWidth = 500;
  doc.mainCanvas.clientHeight = 400;
  sp.resize();
  assertEquals([sp.canvas.width, sp.canvas.height, sp.spectrumHeight], [500, 400, 200]);
  assertEquals(sp.axes.height, 200);
});

Deno.test("cursorUp/Down: steps by #step and clamps to span", () => {
  const { sp, doc } = make();
  doc.el("step").value = "250000";
  sp.cursorUp();
  assertEquals(sp.cursor_freq, 10_250_000);
  sp.cursorUp();
  sp.cursorUp();
  assertEquals(sp.cursor_freq, 10_512_000);
  sp.cursorDown();
  assertEquals(sp.cursor_freq, 10_262_000);
});

Deno.test("throughput: 200 frames of 4096 bins stays fast", () => {
  const { sp } = make({ ...RADIO, bins: 4096, averaging: 4, maxHold: true });
  const r = prng(7);
  const frames = Array.from({ length: 8 }, () => Float32Array.from(randomBins(4096, r)));
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) sp.addData(frames[i % frames.length]);
  const ms = (performance.now() - t0) / 200;
  assert(ms < 20, `addData averaged ${ms.toFixed(2)} ms/frame`);
});
