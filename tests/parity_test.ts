// deno-lint-ignore-file no-console -- these tests stub console.error
/**
 * Drop-in parity: the original spectrum.js and the wasm port are driven
 * through identical scenarios against recording canvas mocks. Their draw-call
 * logs (including every waterfall pixel) and public state must match exactly.
 */

import { assertEquals } from "@std/assert";
import { MockDocument, prng, randomBins } from "./helpers/mock_dom.ts";
import { defaultColormaps, loadOriginal, loadWasm, type SpectrumCtor } from "./helpers/load.ts";

const COLORMAPS = defaultColormaps();

// deno-lint-ignore no-explicit-any
type Sp = any;
type Scenario = (sp: Sp, doc: MockDocument, Ctor: SpectrumCtor) => void;

interface Run {
  log: unknown[];
  state: Record<string, unknown>;
}

const STATE_FIELDS = [
  "centerHz",
  "spanHz",
  "wf_size",
  "wf_rows",
  "spectrumPercent",
  "averaging",
  "alpha",
  "maxHold",
  "bins",
  "paused",
  "fullscreen",
  "min_db",
  "max_db",
  "wf_min_db",
  "wf_max_db",
  "spectrumHeight",
  "colorindex",
  "start_freq",
  "nbins",
  "autoscale",
  "decay",
  "cursor_active",
  "cursor_freq",
  "frequency",
  "filter_low",
  "filter_high",
];

function snapshot(sp: Sp): Record<string, unknown> {
  const s: Record<string, unknown> = {};
  for (const f of STATE_FIELDS) s[f] = sp[f];
  for (const f of ["binsAverage", "binsMax", "binsMin"]) {
    s[f] = sp[f] === undefined ? undefined : Array.from(sp[f] as ArrayLike<number>);
  }
  s.colormapIsDefault = sp.colormap === COLORMAPS[sp.colorindex];
  return s;
}

function run(
  which: "original" | "wasm",
  scenario: Scenario,
  options?: Record<string, unknown>,
  docSize: [number, number] = [1024, 600],
): Run {
  const doc = new MockDocument("waterfall", docSize[0], docSize[1]);
  const host = { document: doc, colormaps: COLORMAPS };
  const Ctor = which === "original" ? loadOriginal(host) : loadWasm(host);
  const quietError = console.error;
  console.error = () => {}; // the original logs from its NaN catch block
  try {
    const sp = new Ctor("waterfall", options);
    scenario(sp, doc, Ctor);
    return { log: doc.log, state: snapshot(sp) };
  } finally {
    console.error = quietError;
  }
}

function parity(
  name: string,
  scenario: Scenario,
  options?: Record<string, unknown>,
  docSize?: [number, number],
) {
  Deno.test(`parity: ${name}`, () => {
    const a = run("original", scenario, options, docSize);
    const b = run("wasm", scenario, options, docSize);
    assertEquals(b.log.length, a.log.length, "draw-call count differs");
    for (let i = 0; i < a.log.length; i++) {
      assertEquals(b.log[i], a.log[i], `draw call #${i} differs`);
    }
    assertEquals(b.state, a.state);
  });
}

const RADIO = { centerHz: 10_000_000, spanHz: 1_024_000, bins: 1024 };

function frames(sp: Sp, n: number, len: number, seed: number) {
  const r = prng(seed);
  for (let i = 0; i < n; i++) sp.addData(randomBins(len, r));
}

// ---- construction -------------------------------------------------------

parity("construct with no options", () => {});
parity("construct with radio options", () => {}, { ...RADIO, averaging: 4, maxHold: true });
parity("construct with custom wf_rows / percent / step", () => {}, {
  wf_rows: 64,
  spectrumPercent: 30,
  spectrumPercentStep: 10,
});
parity("construct on zero-size canvas", () => {}, RADIO, [0, 0]);

// ---- data path ----------------------------------------------------------

parity("single frame", (sp) => {
  sp.setLowHz(9_500_000);
  sp.setHighHz(10_500_000);
  frames(sp, 1, 1024, 1);
}, RADIO);

parity("many frames, no averaging", (sp) => {
  sp.setHighHz(10_600_000);
  frames(sp, 12, 1024, 2);
}, RADIO);

parity("averaging", (sp) => {
  sp.setAveraging(7);
  frames(sp, 10, 1024, 3);
}, RADIO);

parity("averaging reset on length change", (sp) => {
  sp.setAveraging(3);
  frames(sp, 3, 1024, 4);
  frames(sp, 3, 512, 5);
}, RADIO);

parity("max/min hold, no decay", (sp) => {
  sp.setMaxHold(true);
  frames(sp, 10, 1024, 6);
}, RADIO);

parity("max hold with decay and averaging", (sp) => {
  sp.setMaxHold(true);
  sp.setDecay(0.97);
  sp.setAveraging(2);
  frames(sp, 10, 1024, 7);
}, RADIO);

parity("max hold toggled off and on", (sp) => {
  sp.toggleMaxHold();
  frames(sp, 3, 1024, 8);
  sp.toggleMaxHold();
  frames(sp, 2, 1024, 9);
  sp.toggleMaxHold();
  frames(sp, 2, 1024, 10);
}, RADIO);

parity("trace visibility checkboxes", (sp, doc) => {
  sp.setMaxHold(true);
  (doc.elements.check_live as { checked: boolean }).checked = false;
  frames(sp, 2, 1024, 11);
  (doc.elements.check_max as { checked: boolean }).checked = false;
  (doc.elements.check_live as { checked: boolean }).checked = true;
  frames(sp, 2, 1024, 12);
  (doc.elements.check_min as { checked: boolean }).checked = false;
  frames(sp, 2, 1024, 13);
}, RADIO);

parity("Float32Array input", (sp) => {
  const r = prng(14);
  sp.setAveraging(2);
  sp.setMaxHold(true);
  for (let i = 0; i < 4; i++) sp.addData(Float32Array.from(randomBins(1024, r)));
}, RADIO);

parity("waterfall size changes between frames", (sp) => {
  frames(sp, 2, 256, 15);
  frames(sp, 2, 2048, 16);
  frames(sp, 1, 1, 17);
}, RADIO);

parity("NaN, Infinity and out-of-range bins", (sp) => {
  const bins = randomBins(1024, prng(18));
  bins[0] = NaN;
  bins[1] = Infinity;
  bins[2] = -Infinity;
  bins[3] = 500;
  bins[4] = -500;
  bins[5] = -120;
  bins[6] = 0;
  sp.addData(bins);
}, RADIO);

parity("waterfall range equal min/max", (sp) => {
  sp.setRange(-50, -50, true);
  frames(sp, 2, 512, 19);
}, RADIO);

// ---- autoscale ----------------------------------------------------------

parity("autoscale", (sp) => {
  frames(sp, 1, 1024, 20);
  sp.forceAutoscale();
  frames(sp, 2, 1024, 21);
}, RADIO);

parity("autoscale with max hold", (sp) => {
  sp.setMaxHold(true);
  frames(sp, 3, 1024, 22);
  sp.forceAutoscale();
  frames(sp, 1, 1024, 23);
}, RADIO);

parity("autoscale on exact 5 dB boundaries", (sp) => {
  sp.forceAutoscale();
  sp.addData([-100, -55, -20, -95]);
}, RADIO);

// ---- range / layout -----------------------------------------------------

parity("range and position keys", (sp) => {
  sp.positionUp();
  sp.positionUp();
  sp.positionDown();
  sp.rangeIncrease();
  sp.rangeDecrease();
  sp.rangeDecrease();
  frames(sp, 2, 1024, 24);
}, RADIO);

parity("rangeDecrease stops at 10 dB span", (sp) => {
  sp.setRange(-30, -15, true);
  for (let i = 0; i < 5; i++) sp.rangeDecrease();
  frames(sp, 1, 1024, 25);
}, RADIO);

parity("spectrum percent up/down to the limits", (sp) => {
  for (let i = 0; i < 25; i++) sp.incrementSpectrumPercent();
  frames(sp, 1, 1024, 26);
  for (let i = 0; i < 25; i++) sp.decrementSpectrumPercent();
  frames(sp, 1, 1024, 27);
  sp.setSpectrumPercent(150);
  sp.setSpectrumPercent(35);
  frames(sp, 1, 1024, 28);
}, RADIO);

parity("canvas resize between frames", (sp, doc) => {
  frames(sp, 1, 1024, 29);
  doc.mainCanvas.clientWidth = 640;
  doc.mainCanvas.clientHeight = 900;
  frames(sp, 2, 1024, 30);
}, RADIO);

parity("center/span changes", (sp) => {
  sp.setCenterHz(14_100_000);
  sp.setSpanHz(4_096_000);
  sp.setHighHz(16_000_000);
  frames(sp, 2, 1024, 31);
}, RADIO);

for (
  const ratio of [40, 80, 200, 400, 800, 1000, 2000, 4000, 8000, 16000, 20000, 123, 7.5]
) {
  parity(`axis ticks for ${ratio} Hz/bin`, (sp) => {
    sp.setCenterHz(30_000_000);
    sp.setHighHz(30_000_000 + ratio * 512);
    frames(sp, 1, 1024, 32);
    sp.setSpanHz(ratio * 1024);
  }, { centerHz: 30_000_000, spanHz: ratio * 1024, bins: 1024 });
}

// ---- colormaps ----------------------------------------------------------

parity("toggleColor cycles through all maps", (sp) => {
  for (let i = 0; i < COLORMAPS.length + 2; i++) {
    sp.toggleColor();
    frames(sp, 1, 512, 40 + i);
  }
}, RADIO);

parity("setColormap including out-of-range index", (sp) => {
  sp.setColormap(3);
  frames(sp, 1, 512, 50);
  sp.setColormap(99);
  frames(sp, 1, 512, 51);
}, RADIO);

parity("colormap replaced directly on the instance", (sp) => {
  sp.colormap = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
  frames(sp, 1, 512, 52);
  sp.colormap = [[1.5, 300, -4], [2.5, 3.5, 254.5]];
  frames(sp, 1, 512, 53);
}, RADIO);

// ---- cursor / filter / pointer ------------------------------------------

parity("filter and pointer", (sp) => {
  sp.setFrequency(10_100_000);
  sp.setFilter(-3000, 3000);
  frames(sp, 2, 1024, 60);
}, RADIO);

parity("cursor active and stepping", (sp, doc) => {
  (doc.elements.cursor as { checked: boolean }).checked = true;
  sp.cursorCheck();
  sp.cursorUp();
  sp.cursorUp();
  sp.cursorDown();
  frames(sp, 1, 1024, 61);
  (doc.elements.step as { value: string }).value = "5000000";
  sp.cursorUp();
  sp.cursorUp();
  frames(sp, 1, 1024, 62);
  sp.cursorDown();
  sp.cursorDown();
  sp.cursorDown();
  frames(sp, 1, 1024, 63);
}, RADIO);

// ---- pause / keys / fullscreen ------------------------------------------

parity("paused frames are ignored", (sp) => {
  frames(sp, 1, 1024, 70);
  sp.togglePaused();
  frames(sp, 3, 1024, 71);
  sp.togglePaused();
  frames(sp, 1, 1024, 72);
}, RADIO);

parity("every keyboard shortcut", (sp) => {
  for (
    const key of [
      "c",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "s",
      "w",
      "+",
      "+",
      "-",
      "m",
      "f",
      "f",
      "x",
      " ",
      " ",
    ]
  ) {
    sp.onKeypress({ key });
    frames(sp, 1, 512, key.charCodeAt(0));
  }
}, RADIO);

// ---- radio_pointer settings hook ----------------------------------------

parity("radio_pointer.saveSettings is called on the same events", (sp, doc) => {
  sp.radio_pointer = { saveSettings: () => doc.log.push(["saveSettings"]) };
  sp.setRange(-100, -10, false);
  sp.setAveraging(3);
  sp.toggleMaxHold();
  frames(sp, 2, 1024, 80);
  sp.setDecay(0.9);
  sp.decrementAveraging();
  sp.incrementSpectrumPercent();
}, RADIO);

// ---- bin <-> hz conversions ---------------------------------------------

Deno.test("parity: bin/hz/pixel conversions over random inputs", () => {
  const docA = new MockDocument();
  const docB = new MockDocument();
  const a = new (loadOriginal({ document: docA, colormaps: COLORMAPS }))("waterfall", RADIO);
  const b = new (loadWasm({ document: docB, colormaps: COLORMAPS }))("waterfall", RADIO);
  const r = prng(90);
  for (let i = 0; i < 2000; i++) {
    const hz = 9_000_000 + r() * 2_000_000;
    const bin = Math.floor(r() * 1200) - 100;
    const px = r() * 1100 - 50;
    assertEquals(b.hz_to_bin(hz), a.hz_to_bin(hz));
    assertEquals(b.bin_to_hz(bin), a.bin_to_hz(bin));
    assertEquals(b.pixel_to_bin(px), a.pixel_to_bin(px));
    assertEquals(b.limitCursor(hz * 1.2 - 1e6), a.limitCursor(hz * 1.2 - 1e6));
    const v = -140 + r() * 160;
    assertEquals(b.squeeze(v, 0, 255), a.squeeze(v, 0, 255));
  }
});

Deno.test("parity: conversions when bins option is absent", () => {
  const docA = new MockDocument();
  const docB = new MockDocument();
  const a = new (loadOriginal({ document: docA, colormaps: COLORMAPS }))("waterfall", {});
  const b = new (loadWasm({ document: docB, colormaps: COLORMAPS }))("waterfall", {});
  assertEquals(b.hz_to_bin(1000), a.hz_to_bin(1000));
  assertEquals(b.bin_to_hz(3), a.bin_to_hz(3));
  assertEquals(b.pixel_to_bin(10), a.pixel_to_bin(10));
  assertEquals(b.limitCursor(5), a.limitCursor(5));
});

Deno.test("parity: identical prototype surface", () => {
  const host = { document: new MockDocument(), colormaps: COLORMAPS };
  const a = Object.keys(loadOriginal(host).prototype).sort();
  const b = Object.keys(loadWasm(host).prototype).sort();
  assertEquals(b, a);
});

Deno.test("parity: identical instance fields after construction", () => {
  const a = new (loadOriginal({ document: new MockDocument(), colormaps: COLORMAPS }))(
    "waterfall",
    RADIO,
  );
  const b = new (loadWasm({ document: new MockDocument(), colormaps: COLORMAPS }))(
    "waterfall",
    RADIO,
  );
  assertEquals(Object.keys(b).sort(), Object.keys(a).sort());
});
