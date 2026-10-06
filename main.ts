/**
 * Dev / demo server for spectrum-wasm.
 *
 *   /                      test interface (public/index.html)
 *   /embed.html            minimal drop-in usage example
 *   /dist/spectrum.js      drop-in classic script (wasm embedded)
 *   /dist/spectrum.mjs     ES module build
 *   /dist/spectrum_wasm.wasm
 *   /contrib/spectrum.js   the original, for side-by-side comparison
 *   /healthz               JSON liveness probe
 *
 * Every response carries permissive CORS / CORP headers so the component and
 * the test page can be loaded from other hosts.
 *
 * Env: PORT (default 8000), HOSTNAME (default 0.0.0.0).
 */

import { extname, fromFileUrl, join, normalize } from "@std/path";

const ROOT = fromFileUrl(new URL("./", import.meta.url));

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  "cross-origin-resource-policy": "cross-origin",
};

/** Map a URL path to [directory, relative path] or null if not served. */
export function resolvePath(pathname: string): [string, string] | null {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (p.includes("\0")) return null;
  // Reject any traversal attempt before normalising.
  if (p.split("/").some((seg) => seg === "..")) return null;
  p = normalize(p).replaceAll("\\", "/");

  if (p === "/" || p === "") return ["public", "index.html"];
  if (p.startsWith("/dist/")) return ["dist", p.slice("/dist/".length)];
  if (p === "/contrib/spectrum.js") return [".contrib", "spectrum.js"];
  return ["public", p.replace(/^\/+/, "")];
}

function withHeaders(body: BodyInit | null, status: number, headers: Record<string, string>) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      ...headers,
    },
  });
}

export interface HandlerOptions {
  root?: string;
}

export function createHandler(opts: HandlerOptions = {}): (req: Request) => Promise<Response> {
  const root = opts.root ?? ROOT;

  return async (req: Request) => {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return withHeaders(null, 204, {});
    if (req.method !== "GET" && req.method !== "HEAD") {
      return withHeaders("Method Not Allowed", 405, { allow: "GET, HEAD, OPTIONS" });
    }

    if (url.pathname === "/healthz") {
      return withHeaders(JSON.stringify({ ok: true, time: new Date().toISOString() }), 200, {
        "content-type": MIME[".json"],
      });
    }

    const resolved = resolvePath(url.pathname);
    if (!resolved) return withHeaders("Bad Request", 400, { "content-type": MIME[".txt"] });
    const [dir, rel] = resolved;
    const file = join(root, dir, rel);
    if (!file.startsWith(join(root, dir))) {
      return withHeaders("Bad Request", 400, { "content-type": MIME[".txt"] });
    }

    try {
      const stat = await Deno.stat(file);
      if (!stat.isFile) throw new Deno.errors.NotFound();
      const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
      const headers = { "content-type": type, "content-length": String(stat.size) };
      if (req.method === "HEAD") return withHeaders(null, 200, headers);
      const body = await Deno.readFile(file);
      return withHeaders(body, 200, headers);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        const hint = dir === "dist" ? " (run `deno task build`)" : "";
        return withHeaders(`Not Found${hint}`, 404, { "content-type": MIME[".txt"] });
      }
      throw e;
    }
  };
}

/** Kept for compatibility with the original scaffold. */
export const handler: (req: Request) => Promise<Response> = createHandler();

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8000);
  const hostname = Deno.env.get("HOSTNAME") ?? "0.0.0.0";
  Deno.serve({
    port,
    hostname,
    onListen({ hostname, port }) {
      const shown = hostname === "0.0.0.0" ? "localhost" : hostname;
      // deno-lint-ignore no-console
      console.log(`spectrum-wasm test interface: http://${shown}:${port}/`);
      if (hostname === "0.0.0.0") {
        for (const ni of Deno.networkInterfaces()) {
          if (ni.family === "IPv4" && !ni.address.startsWith("127.")) {
            // deno-lint-ignore no-console
            console.log(`  on your network:            http://${ni.address}:${port}/`);
          }
        }
      }
    },
  }, handler);
}
