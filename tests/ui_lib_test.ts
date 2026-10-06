/** Unit tests for the test interface's pure logic modules (public/lib). */

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  addDb,
  carrierShape,
  createSignal,
  DEFAULT_SIGNAL,
  mulberry32,
} from "../public/lib/signal.js";
import {
  applySessionToSpectrum,
  defaultSession,
  normalizeSession,
  parseSession,
  serializeSession,
  sessionFileName,
  sessionFromSpectrum,
  UNTITLED,
} from "../public/lib/session.js";
import {
  applyTheme,
  loadPref,
  nextPref,
  normalizePref,
  resolveTheme,
  savePref,
  THEME_KEY,
} from "../public/lib/theme.js";
import { initialWindow, isCanvasVisible, reduceWindow } from "../public/lib/window_state.js";
import { formatDbRange, formatHz, formatMs, FpsMeter, Rolling } from "../public/lib/format.js";
import { runBenchmark, speedup } from "../public/lib/benchmark.js";
import { MockDocument } from "./helpers/mock_dom.ts";
import { defaultColormaps, loadOriginal, loadWasm } from "./helpers/load.ts";

const COLORMAPS = defaultColormaps();

// ---- signal ---------------------------------------------------------------

Deno.test("signal: mulberry32 is deterministic and in [0,1)", () => {
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assertEquals(x, b());
    assert(x >= 0 && x < 1);
  }
});

Deno.test("signal: addDb power-sums", () => {
  assertAlmostEquals(addDb(-50, -50), -46.9897, 1e-3);
  assertAlmostEquals(addDb(-30, -100), -30, 1e-6);
});

Deno.test("signal: carrierShape is -3 dB at one width", () => {
  assertEquals(carrierShape(-40, 2, 0), -40);
  assertEquals(carrierShape(-40, 2, 2), -43);
});

Deno.test("signal: frame length, range and determinism", () => {
  const f1 = createSignal({ bins: 2048 }, 3).next(0);
  const f2 = createSignal({ bins: 2048 }, 3).next(0);
  assertEquals(f1.length, 2048);
  assertEquals(f1, f2);
  for (const v of f1) assert(v <= 0 && v >= -140);
});

Deno.test("signal: strongest carrier is at its configured position", () => {
  const f = createSignal({ bins: 1024, sweep: false }, 1).next(0);
  let peak = 0;
  for (let i = 1; i < f.length; i++) if (f[i] > f[peak]) peak = i;
  assert(Math.abs(peak - 0.5 * 1023) <= 1, `peak at ${peak}`);
  assertAlmostEquals(f[peak], -30, 1.5);
});

Deno.test("signal: pulsed carrier switches off", () => {
  const sig = createSignal({ bins: 1024, sweep: false, noise: 0 }, 1);
  const at = Math.round(0.64 * 1023);
  const on = sig.next(0)[at];
  const off = sig.next(DEFAULT_SIGNAL.carriers[3].pulse ?? 0)[at];
  assert(on > off + 20, `${on} vs ${off}`);
});

Deno.test("signal: configure changes bin count", () => {
  const sig = createSignal({ bins: 512 });
  sig.configure({ bins: 300 });
  assertEquals(sig.next(0).length, 300);
});

// ---- session --------------------------------------------------------------

Deno.test("session: defaults round-trip through serialize/parse", () => {
  assertEquals(parseSession(serializeSession(defaultSession())), defaultSession());
});

Deno.test("session: missing fields take defaults", () => {
  const s = normalizeSession({ centerHz: 7_000_000 });
  assertEquals(s.centerHz, 7_000_000);
  assertEquals(s.spanHz, defaultSession().spanHz);
});

Deno.test("session: non-objects normalize to defaults", () => {
  assertEquals(normalizeSession(null), defaultSession());
  assertEquals(normalizeSession(42), defaultSession());
  assertEquals(normalizeSession("x"), defaultSession());
});

Deno.test("session: clamps and rounds", () => {
  const s = normalizeSession({ spectrumPercent: 250, averaging: 3.7, bins: 1, fps: 0 });
  assertEquals([s.spectrumPercent, s.averaging, s.bins, s.fps], [100, 4, 16, 1]);
});

Deno.test("session: numeric strings accepted, junk rejected", () => {
  const s = normalizeSession({ centerHz: "14074000", spanHz: "abc", minDb: "", maxDb: NaN });
  assertEquals(s.centerHz, 14_074_000);
  assertEquals(s.spanHz, defaultSession().spanHz);
  assertEquals(s.minDb, -120);
  assertEquals(s.maxDb, 0);
});

Deno.test("session: inverted ranges are repaired", () => {
  const s = normalizeSession({ minDb: -10, maxDb: -50, filterLow: 3000, filterHigh: -3000 });
  assertEquals([s.minDb, s.maxDb], [-120, 0]);
  assertEquals([s.filterLow, s.filterHigh], [-3000, 3000]);
});

Deno.test("session: invalid waterfall range follows spectrum range", () => {
  const s = normalizeSession({ minDb: -90, maxDb: -20, wfMinDb: 0, wfMaxDb: 0 });
  assertEquals([s.wfMinDb, s.wfMaxDb], [-90, -20]);
});

Deno.test("session: maxHold must be literally true", () => {
  assertEquals(normalizeSession({ maxHold: "true" }).maxHold, false);
  assertEquals(normalizeSession({ maxHold: true }).maxHold, true);
});

Deno.test("session: parse rejects invalid JSON", () => {
  assertThrows(() => parseSession("{nope"), SyntaxError);
});

Deno.test("session: file names", () => {
  assertEquals(sessionFileName("band scan"), "band scan.spectrum.json");
  assertEquals(sessionFileName("a.json"), "a.spectrum.json");
  assertEquals(sessionFileName("b.spectrum.json"), "b.spectrum.json");
  assertEquals(sessionFileName("../../etc/x"), "x.spectrum.json");
  assertEquals(sessionFileName("C:\\tmp\\y"), "y.spectrum.json");
  assertEquals(sessionFileName('bad<>:"|?*'), "bad_______.spectrum.json");
  assertEquals(sessionFileName("   "), UNTITLED);
});

for (const impl of ["original", "wasm"] as const) {
  Deno.test(`session: apply then capture round-trips on ${impl} Spectrum`, () => {
    const host = { document: new MockDocument(), colormaps: COLORMAPS };
    const Ctor = impl === "original" ? loadOriginal(host) : loadWasm(host);
    const sp = new Ctor("waterfall", { centerHz: 1, spanHz: 1, bins: 1024 });
    const s = normalizeSession({
      centerHz: 14_100_000,
      spanHz: 2_048_000,
      lowHz: 14_000_000,
      highHz: 14_350_000,
      minDb: -110,
      maxDb: -20,
      wfMinDb: -100,
      wfMaxDb: -30,
      colormap: 2,
      averaging: 5,
      decay: 0.95,
      maxHold: true,
      spectrumPercent: 40,
      frequency: 14_074_000,
      filterLow: 200,
      filterHigh: 2800,
    });
    applySessionToSpectrum(sp, s);
    const back = sessionFromSpectrum(sp, { bins: s.bins, fps: s.fps, noiseFloor: s.noiseFloor });
    assertEquals(back, s);
  });
}

// ---- theme ----------------------------------------------------------------

Deno.test("theme: normalizePref", () => {
  assertEquals(normalizePref("dark"), "dark");
  assertEquals(normalizePref("purple"), "system");
  assertEquals(normalizePref(null), "system");
});

Deno.test("theme: resolveTheme", () => {
  assertEquals(resolveTheme("light", true), "light");
  assertEquals(resolveTheme("dark", false), "dark");
  assertEquals(resolveTheme("system", true), "dark");
  assertEquals(resolveTheme("system", false), "light");
});

Deno.test("theme: nextPref cycles", () => {
  assertEquals(nextPref("light"), "dark");
  assertEquals(nextPref("dark"), "system");
  assertEquals(nextPref("system"), "light");
});

Deno.test("theme: load/save via storage", () => {
  const m = new Map<string, string>();
  const storage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  } as unknown as Storage;
  assertEquals(loadPref(storage), "system");
  assert(savePref(storage, "dark"));
  assertEquals(m.get(THEME_KEY), "dark");
  assertEquals(loadPref(storage), "dark");
});

Deno.test("theme: storage failures are swallowed", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("denied");
    },
  } as unknown as Storage;
  assertEquals(loadPref(broken), "system");
  assertEquals(savePref(broken, "light"), false);
  assertEquals(loadPref(undefined), "system");
});

Deno.test("theme: applyTheme sets or clears data-theme", () => {
  const attrs = new Map<string, string>();
  const root = {
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
  };
  applyTheme(root, "dark");
  assertEquals(attrs.get("data-theme"), "dark");
  applyTheme(root, "system");
  assertEquals(attrs.has("data-theme"), false);
});

// ---- window state ---------------------------------------------------------

Deno.test("window: starts normal", () => {
  assertEquals(initialWindow(), { state: "normal", restore: "normal" });
});

Deno.test("window: fit toggles with normal", () => {
  const w1 = reduceWindow(initialWindow(), "fit");
  assertEquals(w1.state, "fit");
  assertEquals(reduceWindow(w1, "fit").state, "normal");
});

Deno.test("window: minimize restores to the previous layout", () => {
  const fit = reduceWindow(initialWindow(), "fit");
  const min = reduceWindow(fit, "minimize");
  assertEquals(min.state, "minimized");
  assertEquals(reduceWindow(min, "minimize").state, "fit");
});

Deno.test("window: hide/show restores to the previous layout", () => {
  const fit = reduceWindow(initialWindow(), "fit");
  const hidden = reduceWindow(fit, "hide");
  assertEquals(hidden.state, "hidden");
  assertEquals(reduceWindow(hidden, "show").state, "fit");
});

Deno.test("window: hide from minimized, show returns to un-minimized layout", () => {
  const w = reduceWindow(reduceWindow(initialWindow(), "minimize"), "hide");
  assertEquals(reduceWindow(w, "show").state, "normal");
});

Deno.test("window: toggleHidden", () => {
  const h = reduceWindow(initialWindow(), "toggleHidden");
  assertEquals(h.state, "hidden");
  assertEquals(reduceWindow(h, "toggleHidden").state, "normal");
});

Deno.test("window: show when visible is a no-op", () => {
  const w = initialWindow();
  assertEquals(reduceWindow(w, "show"), w);
});

Deno.test("window: fit from minimized or hidden goes straight to fit", () => {
  assertEquals(reduceWindow(reduceWindow(initialWindow(), "minimize"), "fit").state, "fit");
  assertEquals(reduceWindow(reduceWindow(initialWindow(), "hide"), "fit").state, "fit");
});

Deno.test("window: unknown action leaves state unchanged", () => {
  const w = initialWindow();
  // deno-lint-ignore no-explicit-any
  assertEquals(reduceWindow(w, "explode" as any), w);
});

Deno.test("window: canvas visibility", () => {
  assert(isCanvasVisible({ state: "normal", restore: "normal" }));
  assert(isCanvasVisible({ state: "fit", restore: "fit" }));
  assert(!isCanvasVisible({ state: "minimized", restore: "normal" }));
  assert(!isCanvasVisible({ state: "hidden", restore: "normal" }));
});

// ---- format ---------------------------------------------------------------

Deno.test("format: formatHz units", () => {
  assertEquals(formatHz(10_000_000), "10.000 MHz");
  assertEquals(formatHz(2_400_000_000), "2.400 GHz");
  assertEquals(formatHz(12_500), "12.500 kHz");
  assertEquals(formatHz(440), "440 Hz");
  assertEquals(formatHz(-1_500_000, 1), "-1.5 MHz");
  assertEquals(formatHz(NaN), "—");
});

Deno.test("format: formatMs", () => {
  assertEquals(formatMs(0.25), "250 µs");
  assertEquals(formatMs(3.14159), "3.14 ms");
  assertEquals(formatMs(NaN), "—");
});

Deno.test("format: formatDbRange", () => {
  assertEquals(formatDbRange(-120, 0), "-120 … 0 dB");
});

Deno.test("format: Rolling mean over a window", () => {
  const r = new Rolling(3);
  assert(Number.isNaN(r.mean));
  r.push(1).push(2).push(3).push(10);
  assertEquals(r.mean, 5);
  r.reset();
  assert(Number.isNaN(r.mean));
});

Deno.test("format: FpsMeter", () => {
  const f = new FpsMeter(10);
  assertEquals(f.fps, 0);
  for (let t = 0; t <= 1000; t += 40) f.tick(t);
  assertAlmostEquals(f.fps, 25, 1e-9);
  f.reset();
  assertEquals(f.fps, 0);
});

// ---- benchmark ------------------------------------------------------------

Deno.test("benchmark: runs every case and reports timings", () => {
  let clock = 0;
  const cases = (["original", "wasm"] as const).map((name) => ({
    name,
    create: () => {
      const host = { document: new MockDocument(), colormaps: COLORMAPS };
      const C = name === "original" ? loadOriginal(host) : loadWasm(host);
      return new C("waterfall", { centerHz: 10e6, spanHz: 1_024_000, bins: 1024 });
    },
  }));
  const frames = [createSignal({ bins: 1024 }).next(0)];
  const res = runBenchmark(cases, frames, {
    iterations: 5,
    warmup: 1,
    rounds: 2,
    now: () => (clock += 10),
  });
  assertEquals(res.map((r) => r.name), ["original", "wasm"]);
  for (const r of res) {
    assertEquals(r.addDataMs, 2); // 10 ms clock step / 5 iterations
    assertEquals(r.waterfallMs, 2);
  }
});

Deno.test("benchmark: keeps the best of interleaved rounds", () => {
  const order: string[] = [];
  // Four clock reads per case per round: addData start/end, waterfall start/end.
  const times = [0, 50, 50, 60, 0, 10, 10, 20, 0, 30, 30, 30, 0, 40, 40, 40];
  let t = 0;
  const fake = (name: string) => ({
    name,
    create: () => ({
      setAveraging() {},
      setMaxHold() {},
      addData() {
        order.push(name);
      },
      rowToImageData() {},
    }),
  });
  const res = runBenchmark([fake("a"), fake("b")], [[0]], {
    iterations: 1,
    warmup: 0,
    rounds: 2,
    now: () => times[t++],
  });
  assertEquals(order, ["a", "b", "a", "b"]);
  assertEquals(res.map((r) => [r.addDataMs, r.waterfallMs]), [[30, 0], [10, 0]]);
});

Deno.test("benchmark: rejects empty frames", () => {
  assertThrows(() => runBenchmark([], []), RangeError);
});

Deno.test("benchmark: speedup", () => {
  assertEquals(speedup(10, 5), 2);
  assertEquals(speedup(10, 0), Infinity);
});
