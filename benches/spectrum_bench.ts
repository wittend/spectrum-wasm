/**
 * Original spectrum.js vs spectrum-wasm, with canvas calls stubbed out so the
 * numbers reflect the JavaScript / WebAssembly work only.
 *
 *   deno task bench
 */

import { createSignal } from "../public/lib/signal.js";
import { defaultColormaps, loadOriginal, loadWasm, newCore } from "../tests/helpers/load.ts";
import type { MockDocument } from "../tests/helpers/mock_dom.ts";

const COLORMAPS = defaultColormaps();

/** A document whose canvases accept every call and do nothing. */
function nullDocument(): MockDocument {
  const noop = () => {};
  const ctx = (canvas: unknown) => ({
    canvas,
    fillRect: noop,
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    stroke: noop,
    fill: noop,
    save: noop,
    restore: noop,
    scale: noop,
    fillText: noop,
    drawImage: noop,
    putImageData: noop,
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => ({ addColorStop: noop }),
  });
  const canvas = (w: number, h: number) => {
    const c: Record<string, unknown> = { width: w, height: h, clientWidth: w, clientHeight: h };
    const context = ctx(c);
    c.getContext = () => context;
    return c;
  };
  const main = canvas(1024, 600);
  const els: Record<string, unknown> = {
    waterfall: main,
    "check_live": { checked: true },
    "check_max": { checked: true },
    "check_min": { checked: true },
  };
  return {
    getElementById: (id: string) => els[id],
    createElement: () => canvas(0, 0),
  } as unknown as MockDocument;
}

for (const bins of [1024, 4096, 16384]) {
  const sig = createSignal({ bins }, 3);
  const frames = Array.from({ length: 8 }, (_, i) => sig.next(i * 33));
  const opts = { centerHz: 10e6, spanHz: bins * 1000, bins, averaging: 4, maxHold: true };

  for (const impl of ["original", "wasm"] as const) {
    const host = { document: nullDocument(), colormaps: COLORMAPS };
    const Ctor = impl === "original" ? loadOriginal(host) : loadWasm(host, newCore());
    const sp = new Ctor("waterfall", opts);
    let i = 0;

    Deno.bench({
      name: `addData ${impl}`,
      group: `addData ${bins} bins`,
      baseline: impl === "original",
      fn: () => sp.addData(frames[i++ & 7]),
    });

    Deno.bench({
      name: `rowToImageData ${impl}`,
      group: `rowToImageData ${bins} bins`,
      baseline: impl === "original",
      fn: () => sp.rowToImageData(frames[i++ & 7]),
    });
  }
}
