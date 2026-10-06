# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-10-05

Project infrastructure and documentation only. The component's behaviour is unchanged from 0.1.0;
`Spectrum.version` now reports `0.1.1`.

### Added

- `CHANGELOG.md`.
- Gitea Actions workflow (`.gitea/workflows/ci.yml`) mirroring the GitHub CI.
- Self-hosted Gitea Actions runner for that workflow: `gitea/act_runner` in Docker, serving the
  `ubuntu-latest` label with the `docker.gitea.com/runner-images:ubuntu-latest` image. Its
  registration is kept in the named volume `gitea-runner-data`, so the container can be recreated or
  updated without registering again.
- README section on CI, with commands to register and update the Gitea runner.

## [0.1.0] - 2026-10-05

First release.

### Added

- WebAssembly drop-in replacement for `spectrum.js`. The per-bin math is in Rust (`wasm/`), behind a
  plain `extern "C"` ABI with no wasm-bindgen. It keeps the original's constructor, prototype
  methods, instance fields, DOM ids, `colormaps` global and `radio_pointer.saveSettings()` hook.
- Single-file builds with the wasm embedded: `dist/spectrum.js` (classic script, global `Spectrum`)
  and `dist/spectrum.mjs` (ES module), plus `dist/spectrum_wasm.wasm` and default
  `dist/colormaps.js`.
- `Spectrum.ready`, `Spectrum.implementation`, `Spectrum.version` and `Spectrum.core`. Synchronous
  wasm compilation, with an async fallback for engines that refuse it.
- `Deno.serve` dev server with permissive CORS / CORP headers, so the component and test page can be
  used from other hosts (`PORT`, `HOSTNAME`).
- Browser test interface: File / Edit / Tools / Help menus, a New / Save / Save As toolbar for
  session files, a status bar, and light / dark / match-system themes. The window can be fitted to
  the screen, minimized or hidden. It can also switch live to the original implementation and run a
  side-by-side benchmark.
- `embed.html`, a minimal host-page example. `?src=` loads the component from another host.
- 201 Deno unit tests. They include draw-call and pixel parity against the unmodified original, and
  per-kernel checks of JavaScript `Math` semantics.
- `deno bench` suite comparing the original and wasm implementations.
- GitHub Actions CI. It rebuilds with Rust pinned to 1.98.0 and fails if the committed `dist/` is
  stale, then runs fmt, lint, type-check, `cargo test` and the Deno tests.
- MIT license, keeping the original `spectrum.js` notice.

### Changed

Deliberate differences from the original `spectrum.js`:

- `binsAverage`, `binsMax` and `binsMin` are `Float64Array`s instead of `Array`s.
- Autoscale with max hold on before the first frame no longer throws.
- NaN bins paint the last colormap entry without logging an error. The original reached the same
  colour through `try` / `catch`.

### Performance

- Waterfall kernel (`rowToImageData`) about 2.7× faster than the original. Per-frame JavaScript
  work in `addData` is 1.4–1.6× faster (`deno bench`, canvas stubbed). End to end in a browser,
  where canvas drawing dominates, about 1.2× faster.

[Unreleased]: https://github.com/wittend/spectrum-wasm/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/wittend/spectrum-wasm/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/wittend/spectrum-wasm/releases/tag/v0.1.0
