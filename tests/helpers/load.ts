/**
 * Loaders for the two implementations under test.
 *
 *  - loadOriginal: the untouched .contrib/spectrum.js, evaluated with `document`
 *    and `colormaps` injected as its free variables.
 *  - loadWasm: src/spectrum.js bound to a freshly instantiated wasm core.
 */

import { fromFileUrl } from "@std/path";
import { createSpectrumCore, SpectrumCore } from "../../src/wasm_core.js";
import { defineSpectrum } from "../../src/spectrum.js";
import type { MockDocument } from "./mock_dom.ts";

const root = new URL("../../", import.meta.url);
export const WASM_PATH = fromFileUrl(new URL("dist/spectrum_wasm.wasm", root));
export const ORIGINAL_PATH = fromFileUrl(new URL(".contrib/spectrum.js", root));
export const COLORMAPS_PATH = fromFileUrl(new URL("public/colormaps.js", root));

let wasmBytes: Uint8Array | undefined;
let originalSrc: string | undefined;

export function wasmModuleBytes(): Uint8Array {
  if (!wasmBytes) {
    try {
      wasmBytes = Deno.readFileSync(WASM_PATH);
    } catch {
      throw new Error("dist/spectrum_wasm.wasm missing; run `deno task build` first");
    }
  }
  return wasmBytes;
}

/** A fresh core (own memory) per call so tests don't share state. */
export function newCore(): SpectrumCore {
  return createSpectrumCore(wasmModuleBytes() as BufferSource);
}

/** Default colormaps, evaluated from public/colormaps.js. */
export function defaultColormaps(): number[][][] {
  const src = Deno.readTextFileSync(COLORMAPS_PATH);
  const g: { colormaps?: number[][][] } = {};
  new Function("globalThis", src)(g);
  return g.colormaps ?? [];
}

// deno-lint-ignore no-explicit-any
export type SpectrumCtor = new (id: string, options?: Record<string, unknown>) => any;

export interface Host {
  document: MockDocument;
  colormaps: number[][][];
}

export function loadOriginal(host: Host): SpectrumCtor {
  originalSrc ??= Deno.readTextFileSync(ORIGINAL_PATH);
  return new Function(
    "document",
    "colormaps",
    `${originalSrc}\nreturn Spectrum;`,
  )(host.document, host.colormaps);
}

export function loadWasm(host: Host, core: SpectrumCore = newCore()): SpectrumCtor {
  // deno-lint-ignore no-explicit-any
  return defineSpectrum({ core }, host as any) as unknown as SpectrumCtor;
}
