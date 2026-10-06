# spectrum-wasm

A WebAssembly drop-in replacement for `spectrum.js` (© 2019 Jeppe Ledet-Pedersen, MIT), the
spectrum + waterfall canvas display used by ka9q-web and similar SDR front ends.

The original is kept untouched in `.contrib/spectrum.js` and is used by the tests as the reference
implementation.

## Using it

Replace the original include with the built file. The wasm is embedded, so it is still one file:

```html
<script src="colormaps.js"></script>
<!-- your own, or dist/colormaps.js -->
<script src="dist/spectrum.js"></script>
```

`new Spectrum(id, options)`, every prototype method, the instance fields, the DOM ids it reads
(`check_live`, `check_max`, `check_min`, `cursor`, `colormap`, `pause`, `max_hold`, `step`), the
global `colormaps`, and the `radio_pointer.saveSettings()` hook all behave as before.

The ES module build exports the same constructor:

```js
import Spectrum, { ready } from "./dist/spectrum.mjs";
```

The module compiles synchronously when the engine allows it. To be safe on engines that don't,
construct after `await Spectrum.ready`.

### Deliberate differences

- `binsAverage`, `binsMax` and `binsMin` are `Float64Array`s, not `Array`s.
- Autoscale with max hold on before the first frame no longer throws.
- NaN bins paint the last colormap entry without logging. The original reached the same colour via
  `try`/`catch` + `console.error`.
- Extra static properties: `Spectrum.ready`, `Spectrum.implementation` (`"wasm"`),
  `Spectrum.version`, `Spectrum.core`.

Everything else, including the original's quirks, is reproduced exactly: min hold is gated on
`maxHold`, decay multiplies dB values, and axis ticks depend on `nbins`, which is only known after
the first frame. The parity tests enforce this.

## Layout

| Path               | What                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `wasm/src/lib.rs`  | Rust kernels (per-bin math), plain `extern "C"` ABI, no wasm-bindgen   |
| `src/wasm_core.js` | Host wrapper: scratch buffers in linear memory, typed-array marshaling |
| `src/spectrum.js`  | The `Spectrum` constructor: original API, canvas calls, wasm math      |
| `scripts/build.ts` | cargo build, then emits `dist/spectrum.js` (classic) and `.mjs`        |
| `main.ts`          | `Deno.serve` dev server with CORS for cross-host use                   |
| `public/`          | Test interface (`index.html`) and a minimal `embed.html`               |
| `public/lib/`      | Test-interface logic (session file, theme, window state, signal, ...)  |
| `tests/`           | Deno unit tests                                                        |
| `benches/`         | `deno bench`: original vs wasm                                         |

## Tasks

Requires Deno 2.4+ and Rust with the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`).

```bash
deno task build    # cargo build + generate dist/
deno task dev      # build, then serve with --watch on http://localhost:8000
deno task start    # serve without rebuilding
deno task test     # build, then run all unit tests
deno task bench    # build, then benchmark original vs wasm
deno task check    # fmt --check, lint (custom rules), type-check
```

`dist/` is committed so the drop-in can be used without a Rust toolchain. After changing `src/` or
`wasm/`, run `deno task build` and commit `dist/` too. CI fails if it is stale. The wasm bytes
depend on the Rust version, and CI pins `RUST_VERSION` in `.github/workflows/ci.yml` (currently
1.98.0); bump it there when you upgrade Rust locally.

Server environment variables: `PORT` (default 8000) and `HOSTNAME` (default `0.0.0.0`, so other
machines on the network can reach it). Every response sends `Access-Control-Allow-Origin: *` and
`Cross-Origin-Resource-Policy: cross-origin`.

## Test interface

`http://localhost:8000/` has a menubar (File, Edit, Tools, Help), a toolbar (New, Save, Save As,
plus the controls spectrum.js expects), and a status bar. The window can be fitted to the screen,
minimized to its title bar, or hidden (Ctrl+Shift+F / M / H). Light, dark, or match-system theme is
set from Tools → Theme or the button at the right of the menubar.

- **New / Save / Save As** work on a session file (`*.spectrum.json`) holding every Spectrum
  setting. Save uses the File System Access API where available and falls back to a download.
- **Tools → Implementation** switches live between the wasm build and the original.
- **Tools → Benchmark** times both on real canvases.
- `?src=https://other-host:8000/dist/spectrum.js` loads the component from another host. `?impl=original`
  starts on the original.
- `embed.html` is the minimal host-page example: unchanged host code, only the `<script src>`
  differs.

## Tests

`deno task test` runs about 200 granular unit tests:

- **parity_test.ts**: drives the original and the wasm port through the same scenarios against a
  recording canvas mock. Every draw call, every waterfall pixel and the public state must match
  exactly. Scenarios cover averaging, holds, autoscale, NaN/Infinity bins, colormaps, cursor,
  pause, every key binding, resizing, and every axis-increment case.
- **wasm_core_test.ts**: each kernel against the JS expression it replaces, including
  `Math.round`, `Math.min`/`Math.max` NaN and signed-zero semantics, and memory growth.
- **spectrum_test.ts**: port-specific behaviour (readiness, shared cores, deliberate differences).
- **build_test.ts**: the generated `dist/` files load and render identically to the original.
- **server_test.ts**: routing, MIME types, CORS, traversal protection, a real socket.
- **ui_lib_test.ts**: session validation, theme, window state machine, formatting, signal,
  benchmark harness.

## Performance

Measured with `deno bench` on an i7-8700K, canvas calls stubbed out:

| Bins  | `rowToImageData` (waterfall kernel) | `addData` (JS-side work) |
| ----- | ----------------------------------- | ------------------------ |
| 1024  | 2.6× faster                         | 1.4× faster              |
| 4096  | 2.9× faster                         | 1.5× faster              |
| 16384 | 2.7× faster                         | 1.6× faster              |

In a real browser, canvas path drawing is shared by both versions and dominates each frame, so the
end-to-end gain is smaller (about 1.2× in the in-page benchmark).
