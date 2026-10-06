## spectrum-wasm requirements

The purpose of this project is to translate the file contrib/spectrum.js into a wasm servable component that performs like the original. I want it to be as nearly a drop-in replacement as possible.

I want a test harness using Deno. I want granular unit tests. I want to be able to view its operation locally and when served from other hosts.

#### 2026-10-05

- Runtime: Deno stable

Stable, 2.4+.

- HTTP framework: built-in Deno.serve, Oak, Fresh, or none?

Deno.serve.

- Permissions model: strict (--allow-net for specific hosts, etc.) or broad during dev?

Broad during dev.

- Testing expectations: unit only, or also integration/e2e?

Unit testing.

- Lint/format: use deno lint/deno fmt defaults or custom rules?

Custom rules.

- Env/secrets: .env usage, and any secrets management preferences?

Nothing at this time.

The test interface should have a menu, a toolbar, and a status bar. It must be realizable to fit the screen, minimizeable, or hidden.

The toolbar should have buttons for "New", "Save", "Save As". The menubar should have conventional drop-downs for "File", "Edit", "Tools", and "Help". The application will support a light/Dark mode choice from the menubar.
