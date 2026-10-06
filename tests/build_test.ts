/**
 * Tests of the distributable builds in dist/ (run `deno task build` first):
 * the classic drop-in script and the ES module.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { renderClassic, renderModule, stripModuleSyntax } from "../scripts/build.ts";
import { MockDocument, prng, randomBins } from "./helpers/mock_dom.ts";
import { defaultColormaps, loadOriginal } from "./helpers/load.ts";

const dist = (f: string) => fromFileUrl(new URL(`../dist/${f}`, import.meta.url));
const COLORMAPS = defaultColormaps();

/** Evaluate dist/spectrum.js as a classic script against a fake global. */
function loadClassic() {
  const src = Deno.readTextFileSync(dist("spectrum.js"));
  const doc = new MockDocument();
  // deno-lint-ignore no-explicit-any
  const g: any = { document: doc, colormaps: COLORMAPS };
  new Function("globalThis", src)(g);
  return { g, doc };
}

Deno.test("stripModuleSyntax: removes export keywords, imports and ts pragmas", () => {
  const out = stripModuleSyntax(
    `// @ts-check\nimport { x } from "./y.js";\nexport function a() {}\nexport class B {}\nexport async function c() {}\nexport const d = 1;\nconst exported = "export function";`,
  );
  assertEquals(
    out,
    `function a() {}\nclass B {}\nasync function c() {}\nconst d = 1;\nconst exported = "export function";`,
  );
});

Deno.test("renderClassic: wraps in an IIFE and assigns the global", () => {
  const out = renderClassic("export function f() {}", "export function g() {}", "AA==", "1.2.3");
  assertStringIncludes(out, "(function (globalObj) {");
  assertStringIncludes(out, "globalObj.Spectrum = Spectrum;");
  assertStringIncludes(out, '"1.2.3"');
  assert(!/^\s*export /m.test(out));
});

Deno.test("renderModule: exports Spectrum and ready", () => {
  const out = renderModule("", "", "AA==", "1.0.0");
  assertStringIncludes(out, "export { Spectrum, ready,");
  assertStringIncludes(out, "export default Spectrum;");
});

Deno.test("dist/spectrum.js: defines a global Spectrum like the original", () => {
  const { g } = loadClassic();
  assertEquals(typeof g.Spectrum, "function");
  assertEquals(g.Spectrum.name, "Spectrum");
  assertEquals(g.Spectrum.implementation, "wasm");
});

Deno.test("dist/spectrum.js: core is ready synchronously in Deno", async () => {
  const { g } = loadClassic();
  assert(g.Spectrum.core, "core should be instantiated synchronously");
  assertEquals(await g.Spectrum.ready, g.Spectrum);
});

Deno.test("dist/spectrum.js: version matches Cargo.toml", () => {
  const { g } = loadClassic();
  const toml = Deno.readTextFileSync(fromFileUrl(new URL("../wasm/Cargo.toml", import.meta.url)));
  assertEquals(g.Spectrum.version, toml.match(/^version\s*=\s*"([^"]+)"/m)?.[1]);
});

Deno.test("dist/spectrum.js: has the original's prototype surface", () => {
  const { g } = loadClassic();
  const orig = loadOriginal({ document: new MockDocument(), colormaps: COLORMAPS });
  assertEquals(Object.keys(g.Spectrum.prototype).sort(), Object.keys(orig.prototype).sort());
});

Deno.test("dist/spectrum.js: renders identically to the original", () => {
  const { g, doc } = loadClassic();
  const docO = new MockDocument();
  const O = loadOriginal({ document: docO, colormaps: COLORMAPS });
  const opts = { centerHz: 10e6, spanHz: 1_024_000, bins: 1024 };
  const a = new O("waterfall", opts);
  const b = new g.Spectrum("waterfall", opts);
  const r1 = prng(1), r2 = prng(1);
  for (const sp of [a, b]) {
    sp.setAveraging(3);
    sp.setMaxHold(true);
    sp.setHighHz(10.5e6);
  }
  for (let i = 0; i < 5; i++) {
    a.addData(randomBins(1024, r1));
    b.addData(randomBins(1024, r2));
  }
  assertEquals(doc.log, docO.log);
});

Deno.test("dist/spectrum.js: embeds the same bytes as dist/spectrum_wasm.wasm", () => {
  const src = Deno.readTextFileSync(dist("spectrum.js"));
  const b64 = src.match(/const WASM_BASE64 = "([^"]+)"/)?.[1] ?? "";
  const wasm = Deno.readFileSync(dist("spectrum_wasm.wasm"));
  const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  assertEquals(decoded, wasm);
});

Deno.test("dist/spectrum.mjs: imports as an ES module", async () => {
  const mod = await import(dist("spectrum.mjs"));
  assertEquals(typeof mod.default, "function");
  assertEquals(mod.Spectrum, mod.default);
  assertEquals(await mod.ready, mod.Spectrum);
  assertEquals(typeof mod.createSpectrumCoreAsync, "function");
});

Deno.test("dist/colormaps.js: is shipped alongside", () => {
  const src = Deno.readTextFileSync(dist("colormaps.js"));
  assertStringIncludes(src, "g.colormaps =");
});
