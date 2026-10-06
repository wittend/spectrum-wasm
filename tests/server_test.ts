import { assert, assertEquals } from "@std/assert";
import { CORS_HEADERS, createHandler, handler, MIME, resolvePath } from "../main.ts";

const h = createHandler();
const get = (path: string, init?: RequestInit) => h(new Request(`http://localhost${path}`, init));

// ---- resolvePath ----------------------------------------------------------

Deno.test("resolvePath: root serves the test interface", () => {
  assertEquals(resolvePath("/"), ["public", "index.html"]);
});

Deno.test("resolvePath: dist and contrib mappings", () => {
  assertEquals(resolvePath("/dist/spectrum.js"), ["dist", "spectrum.js"]);
  assertEquals(resolvePath("/contrib/spectrum.js"), [".contrib", "spectrum.js"]);
  assertEquals(resolvePath("/lib/signal.js"), ["public", "lib/signal.js"]);
});

Deno.test("resolvePath: rejects traversal, encoded traversal and NUL", () => {
  assertEquals(resolvePath("/../deno.json"), null);
  assertEquals(resolvePath("/dist/../../etc/passwd"), null);
  assertEquals(resolvePath("/%2e%2e/deno.json"), null);
  assertEquals(resolvePath("/a%00b"), null);
  assertEquals(resolvePath("/%E0%A4%A"), null);
});

Deno.test("resolvePath: only the original spectrum.js is exposed from .contrib", () => {
  assertEquals(resolvePath("/contrib/other.js"), ["public", "contrib/other.js"]);
});

// ---- handler --------------------------------------------------------------

Deno.test("GET / returns the test interface HTML", async () => {
  const res = await get("/");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), MIME[".html"]);
  const body = await res.text();
  assert(body.includes('id="waterfall"'));
  assert(body.includes('role="menubar"'));
});

Deno.test("GET /dist/spectrum.js serves JavaScript", async () => {
  const res = await get("/dist/spectrum.js");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), MIME[".js"]);
  assert((await res.text()).includes("globalObj.Spectrum = Spectrum"));
});

Deno.test("GET /dist/spectrum_wasm.wasm uses application/wasm", async () => {
  const res = await get("/dist/spectrum_wasm.wasm");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/wasm");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertEquals(Array.from(bytes.slice(0, 4)), [0, 0x61, 0x73, 0x6d]);
});

Deno.test("GET /contrib/spectrum.js serves the original", async () => {
  const res = await get("/contrib/spectrum.js");
  assertEquals(res.status, 200);
  assert((await res.text()).includes("Jeppe Ledet-Pedersen"));
});

Deno.test("every response carries cross-origin headers", async () => {
  for (const path of ["/", "/dist/spectrum.js", "/missing", "/healthz"]) {
    const res = await get(path);
    await res.body?.cancel();
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      assertEquals(res.headers.get(k), v, `${path} ${k}`);
    }
  }
});

Deno.test("OPTIONS preflight returns 204", async () => {
  const res = await get("/dist/spectrum.js", { method: "OPTIONS" });
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
});

Deno.test("HEAD returns headers without a body", async () => {
  const res = await get("/dist/spectrum.js", { method: "HEAD" });
  assertEquals(res.status, 200);
  assert(Number(res.headers.get("content-length")) > 1000);
  assertEquals(await res.text(), "");
});

Deno.test("POST is rejected with 405", async () => {
  const res = await get("/", { method: "POST" });
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET, HEAD, OPTIONS");
  await res.body?.cancel();
});

Deno.test("missing file is 404; missing dist file hints at build", async () => {
  const a = await get("/nope.html");
  assertEquals(a.status, 404);
  await a.body?.cancel();
  const b = await get("/dist/nope.js");
  assertEquals(b.status, 404);
  assert((await b.text()).includes("deno task build"));
});

Deno.test("directories are not listed", async () => {
  const res = await get("/lib");
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("traversal attempt with encoded slash is 400", async () => {
  const res = await get("/dist/..%2f..%2fdeno.json");
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("dot segments are collapsed by URL parsing and stay inside public/", async () => {
  const res = await get("/%2e%2e/deno.json");
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("/healthz returns JSON", async () => {
  const res = await get("/healthz");
  assertEquals(res.headers.get("content-type"), MIME[".json"]);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(typeof data.time, "string");
});

Deno.test("nosniff and no-cache are set", async () => {
  const res = await get("/app.js");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("cache-control"), "no-cache");
  await res.body?.cancel();
});

Deno.test("default export handler is wired", async () => {
  const res = await handler(new Request("http://localhost/healthz"));
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("serves over a real socket", async () => {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, signal: ac.signal, onListen() {} }, h);
  try {
    const res = await fetch(`http://127.0.0.1:${server.addr.port}/dist/spectrum.mjs`, {
      headers: { origin: "http://other.example" },
    });
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("access-control-allow-origin"), "*");
    await res.body?.cancel();
  } finally {
    ac.abort();
    await server.finished;
  }
});
