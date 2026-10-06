// @ts-nocheck -- DOM glue; logic lives in ./lib (unit-tested).
/**
 * Spectrum WASM test interface.
 *
 * Loads the drop-in build (dist/spectrum.js, or ?src=<url> to load it from
 * another host), drives it with a synthetic receiver, and wraps it in a
 * desktop-style shell: menubar, toolbar, status bar, light/dark theme, and a
 * window that can be fitted to the screen, minimized or hidden.
 */

import { createSignal } from "./lib/signal.js";
import {
  applySessionToSpectrum,
  defaultSession,
  normalizeSession,
  parseSession,
  serializeSession,
  sessionFileName,
  sessionFromSpectrum,
  UNTITLED,
} from "./lib/session.js";
import { applyTheme, loadPref, nextPref, resolveTheme, savePref } from "./lib/theme.js";
import { initialWindow, isCanvasVisible, reduceWindow } from "./lib/window_state.js";
import { formatDbRange, formatHz, formatMs, FpsMeter, Rolling } from "./lib/format.js";
import { runBenchmark, speedup } from "./lib/benchmark.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const params = new URLSearchParams(location.search);
const SPECTRUM_SRC = params.get("src") ?? new URL("dist/spectrum.js", document.baseURI).href;
const ORIGINAL_SRC = params.get("original") ??
  new URL("contrib/spectrum.js", document.baseURI).href;

const IMPL_LABEL = { wasm: "WASM", original: "Original JS" };

const state = {
  /** @type {{ wasm?: Function, original?: Function | null }} */
  impls: {},
  impl: params.get("impl") === "original" ? "original" : "wasm",
  sp: null,
  session: defaultSession(),
  fileName: UNTITLED,
  fileHandle: null,
  namedByUser: false,
  dirty: false,
  savedText: "",
  suppressDirty: 0,
  win: initialWindow(),
  themePref: loadPref(safeStorage()),
  signal: createSignal({ bins: 1024 }),
  fps: new FpsMeter(30),
  frameMs: new Rolling(60),
  lastFrame: 0,
  lastStatus: 0,
  benchmarking: false,
  pointerHz: NaN,
};

function safeStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Loading the implementations
// ---------------------------------------------------------------------------

function loadClassicScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadWasmImpl() {
  await loadClassicScript(SPECTRUM_SRC);
  if (typeof globalThis.Spectrum !== "function") {
    throw new Error(`${SPECTRUM_SRC} did not define Spectrum`);
  }
  await globalThis.Spectrum.ready;
  return globalThis.Spectrum;
}

async function loadOriginalImpl() {
  try {
    const res = await fetch(ORIGINAL_SRC);
    if (!res.ok) return null;
    const src = await res.text();
    // The original is a classic script with free references to `document`
    // and `colormaps`; evaluate it in its own scope so it doesn't replace the
    // global Spectrum defined by the wasm build.
    return new Function("document", "colormaps", `${src}\nreturn Spectrum;`)(
      document,
      globalThis.colormaps,
    );
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spectrum instance
// ---------------------------------------------------------------------------

function quietly(fn) {
  state.suppressDirty++;
  try {
    return fn();
  } finally {
    state.suppressDirty--;
  }
}

function createSpectrum() {
  const Ctor = state.impls[state.impl];
  const s = state.session;
  const sp = new Ctor("waterfall", {
    centerHz: s.centerHz,
    spanHz: s.spanHz,
    bins: s.bins,
    averaging: s.averaging,
    maxHold: s.maxHold,
    spectrumPercent: s.spectrumPercent,
  });
  sp.radio_pointer = { saveSettings: onSpectrumSettingsChanged };
  quietly(() => applySessionToSpectrum(sp, s));
  state.sp = sp;
  state.needAxes = true;
  state.signal.configure({ bins: s.bins, noiseFloor: s.noiseFloor });
  state.fps.reset();
  state.frameMs.reset();
  syncControls();
  updateStatus(true);
}

// The original calls saveSettings() from resize() on every frame, so treat it
// as "something may have changed" and compare against the saved snapshot.
function onSpectrumSettingsChanged() {
  if (!state.suppressDirty) state.checkDirty = true;
}

function refreshDirty() {
  if (!state.checkDirty || !state.sp) return;
  state.checkDirty = false;
  const changed = serializeSession(currentSession()) !== state.savedText;
  if (changed !== state.dirty) setDirty(changed);
}

function markSaved() {
  state.savedText = state.sp ? serializeSession(currentSession()) : "";
  state.checkDirty = false;
  setDirty(false);
}

function currentSession() {
  const s = state.session;
  return sessionFromSpectrum(state.sp, { bins: s.bins, fps: s.fps, noiseFloor: s.noiseFloor });
}

function setImplementation(name) {
  if (name === state.impl || !state.impls[name]) return;
  state.session = currentSession();
  state.impl = name;
  quietly(createSpectrum);
  message(`Switched to ${IMPL_LABEL[name]} implementation`);
  syncMenus();
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

// Frames are pushed on a timer, like a receiver feeding FFTs over a
// WebSocket, rather than pulled by requestAnimationFrame.
function frame() {
  const now = performance.now();
  const interval = 1000 / state.session.fps;
  // Self-correcting schedule: aim for the next slot, never less than 1 ms.
  state.lastFrame = Math.max(state.lastFrame + interval, now - interval);
  setTimeout(frame, Math.max(1, state.lastFrame + interval - performance.now()));

  if (!state.sp || state.benchmarking || !isCanvasVisible(state.win)) {
    if (now - state.lastStatus > 500) updateStatus();
    return;
  }

  const bins = state.signal.next(now);
  if (!state.sp.paused) {
    const t0 = performance.now();
    state.sp.addData(bins);
    state.frameMs.push(performance.now() - t0);
    // Like the original, axis ticks depend on nbins, which is only known once
    // data arrives; redraw them after the first frame of a new instance.
    if (state.needAxes) {
      state.needAxes = false;
      state.sp.updateAxes();
    }
    state.fps.tick(now);
  }
  if (now - state.lastStatus > 250) updateStatus();
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

let messageTimer = 0;
function message(text, ms = 4000) {
  const el = $("#sb-msg");
  el.textContent = text;
  clearTimeout(messageTimer);
  if (ms) messageTimer = setTimeout(() => (el.textContent = ""), ms);
}

function updateStatus(force = false) {
  const sp = state.sp;
  state.lastStatus = performance.now();
  refreshDirty();
  if (!sp && !force) return;
  $("#sb-impl").textContent = IMPL_LABEL[state.impl];
  const visible = isCanvasVisible(state.win);
  $("#sb-run").textContent = state.benchmarking
    ? "Benchmarking"
    : sp?.paused
    ? "Paused"
    : visible
    ? "Running"
    : "Idle (not visible)";
  $("#sb-fps").textContent = `${state.fps.fps.toFixed(1)} fps`;
  $("#sb-frame").textContent = `addData ${formatMs(state.frameMs.mean)}`;
  if (!sp) return;
  $("#sb-freq").textContent = `${formatHz(sp.centerHz)} · span ${formatHz(sp.spanHz)}`;
  $("#sb-range").textContent = formatDbRange(sp.min_db, sp.max_db);
  const names = globalThis.colormapNames ?? [];
  $("#sb-mode").textContent = [
    sp.averaging > 0 ? `avg ${sp.averaging}` : "no avg",
    sp.maxHold ? "hold" : "live",
    names[sp.colorindex] ?? `map ${sp.colorindex}`,
  ].join(" · ");
  $("#sb-cursor").textContent = Number.isFinite(state.pointerHz)
    ? formatHz(state.pointerHz, 4)
    : "—";
  $("#pause").classList.toggle("active", !!sp.paused);
  $("#max_hold").classList.toggle("active", !!sp.maxHold);
}

// ---------------------------------------------------------------------------
// Document (session) state
// ---------------------------------------------------------------------------

function setDirty(d) {
  state.dirty = d;
  const t = $("#doc-title");
  t.textContent = state.fileName;
  t.classList.toggle("dirty", d);
  document.title = `${d ? "• " : ""}${state.fileName} — Spectrum WASM`;
}

function setFile(name, handle, namedByUser) {
  state.fileName = name;
  state.fileHandle = handle;
  state.namedByUser = namedByUser;
  markSaved();
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  const r = await showDialog({
    title: "Discard changes?",
    body: `<p>${esc(state.fileName)} has unsaved changes.</p>`,
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: "Save", value: "save" },
      { label: "Discard", value: "discard", primary: true },
    ],
  });
  if (r === "save") return await fileSave();
  return r === "discard";
}

async function fileNew() {
  if (!(await confirmDiscard())) return;
  state.session = defaultSession();
  quietly(createSpectrum);
  setFile(UNTITLED, null, false);
  message("New session");
}

function hasFsAccess() {
  return typeof globalThis.showSaveFilePicker === "function" && globalThis.isSecureContext;
}

const FILE_TYPES = [{
  description: "Spectrum session",
  accept: { "application/json": [".json"] },
}];

async function writeSession(handle) {
  const text = serializeSession(currentSession());
  if (handle) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
  } else {
    download(new Blob([text], { type: "application/json" }), state.fileName);
  }
}

async function fileSave() {
  if (!state.fileHandle && !state.namedByUser) return await fileSaveAs();
  try {
    await writeSession(state.fileHandle);
    markSaved();
    message(`Saved ${state.fileName}`);
    return true;
  } catch (e) {
    message(`Save failed: ${e.message}`, 8000);
    return false;
  }
}

async function fileSaveAs() {
  if (hasFsAccess()) {
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: state.fileName,
        types: FILE_TYPES,
      });
      state.fileHandle = handle;
      state.fileName = handle.name;
      state.namedByUser = true;
      await writeSession(handle);
      markSaved();
      message(`Saved ${state.fileName}`);
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
      // e.g. SecurityError inside a cross-origin iframe: fall back to download.
    }
  }
  const name = await promptText("Save As", "File name", state.fileName);
  if (name === null) return false;
  setFile(sessionFileName(name), null, true);
  await writeSession(null);
  markSaved();
  message(`Downloaded ${state.fileName}`);
  return true;
}

async function fileOpen() {
  if (!(await confirmDiscard())) return;
  if (typeof globalThis.showOpenFilePicker === "function" && globalThis.isSecureContext) {
    try {
      const [handle] = await globalThis.showOpenFilePicker({ types: FILE_TYPES });
      const file = await handle.getFile();
      return openText(await file.text(), file.name, handle);
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  const input = $("#file-input");
  input.value = "";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) openText(await file.text(), file.name, null);
  };
  input.click();
}

function openText(text, name, handle) {
  let s;
  try {
    s = parseSession(text);
  } catch (e) {
    showDialog({
      title: "Can't open file",
      body: `<p>${esc(name)} is not a valid session file.</p><pre>${esc(e.message)}</pre>`,
      buttons: [{ label: "OK", value: "ok", primary: true }],
    });
    return;
  }
  state.session = s;
  quietly(createSpectrum);
  setFile(name, handle, true);
  message(`Opened ${name}`);
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function canvasBlob() {
  return new Promise((resolve, reject) =>
    $("#waterfall").toBlob((b) => (b ? resolve(b) : reject(new Error("empty canvas"))), "image/png")
  );
}

async function exportPng() {
  const base = state.fileName.replace(/\.spectrum\.json$|\.json$/, "");
  download(await canvasBlob(), `${base}.png`);
  message("Image exported");
}

async function copyImage() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": canvasBlob() })]);
    message("Image copied to clipboard");
  } catch (e) {
    message(`Copy failed: ${e.message}`, 8000);
  }
}

async function copySession() {
  try {
    await navigator.clipboard.writeText(serializeSession(currentSession()));
    message("Session JSON copied");
  } catch (e) {
    message(`Copy failed: ${e.message}`, 8000);
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * @param {{ title: string, body: string | Node, buttons: {label:string,value:string,primary?:boolean}[], onOpen?: (body: HTMLElement) => void }} opts
 * @returns {Promise<string>} the chosen button value ("" on Escape)
 */
function showDialog({ title, body, buttons, onOpen }) {
  const dlg = $("#dialog");
  if (dlg.open) dlg.close("");
  $("#dialog-title").textContent = title;
  const bodyEl = $("#dialog-body");
  bodyEl.replaceChildren();
  if (typeof body === "string") bodyEl.innerHTML = body;
  else bodyEl.append(body);
  const foot = $("#dialog-foot");
  foot.replaceChildren(
    ...buttons.map((b) => {
      const btn = document.createElement("button");
      btn.value = b.value;
      btn.textContent = b.label;
      if (b.primary) btn.className = "primary";
      return btn;
    }),
  );
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
    onOpen?.(bodyEl);
    const primary = foot.querySelector(".primary");
    if (!bodyEl.querySelector("input")) primary?.focus();
  });
}

async function promptText(title, label, value) {
  const r = await showDialog({
    title,
    body: `<div class="form-grid" style="grid-template-columns:1fr"><label>${esc(label)}
      <input type="text" name="prompt" value="${esc(value)}" autocomplete="off" /></label></div>`,
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "OK", value: "ok", primary: true }],
    onOpen(body) {
      const input = body.querySelector("input");
      input.focus();
      input.select();
    },
  });
  if (r !== "ok") return null;
  return $("#dialog-body input[name=prompt]").value;
}

const PREF_FIELDS = [
  ["centerHz", "Center (Hz)"],
  ["spanHz", "Span (Hz)"],
  ["lowHz", "Low edge (Hz)"],
  ["highHz", "High edge (Hz)"],
  ["frequency", "Tuned frequency (Hz)"],
  ["filterLow", "Filter low (Hz)"],
  ["filterHigh", "Filter high (Hz)"],
  ["minDb", "Spectrum min (dB)"],
  ["maxDb", "Spectrum max (dB)"],
  ["wfMinDb", "Waterfall min (dB)"],
  ["wfMaxDb", "Waterfall max (dB)"],
  ["spectrumPercent", "Spectrum height (%)"],
  ["averaging", "Averaging (frames)"],
  ["decay", "Max-hold decay"],
  ["bins", "FFT bins"],
  ["fps", "Frame rate (fps)"],
  ["noiseFloor", "Noise floor (dB)"],
];

async function preferences() {
  const s = currentSession();
  const html = `<div class="form-grid">${
    PREF_FIELDS.map(([k, label]) =>
      `<label>${esc(label)}<input type="number" step="any" name="${k}" value="${s[k]}" /></label>`
    ).join("")
  }<label class="check"><input type="checkbox" name="maxHold" ${
    s.maxHold ? "checked" : ""
  } /> Max hold</label></div>`;
  const r = await showDialog({
    title: "Preferences",
    body: html,
    buttons: [{ label: "Cancel", value: "cancel" }, { label: "Apply", value: "ok", primary: true }],
  });
  if (r !== "ok") return;
  const raw = { ...s };
  for (const [k] of PREF_FIELDS) raw[k] = $(`#dialog-body input[name=${k}]`).value;
  raw.maxHold = $("#dialog-body input[name=maxHold]").checked;
  const next = normalizeSession(raw);
  const rebuild = next.bins !== s.bins;
  state.session = next;
  if (rebuild) quietly(createSpectrum);
  else {
    quietly(() => applySessionToSpectrum(state.sp, next));
    state.signal.configure({ noiseFloor: next.noiseFloor });
    syncControls();
  }
  state.checkDirty = true;
  message("Preferences applied");
}

function shortcuts() {
  const rows = [
    ["Space", "Pause / run"],
    ["F", "Canvas fullscreen"],
    ["C", "Next colormap"],
    ["M", "Max hold"],
    ["A", "Autoscale"],
    ["↑ / ↓", "Shift range down / up 5 dB"],
    ["← / →", "Range narrower / wider 5 dB"],
    ["S / W", "Spectrum taller / shorter"],
    ["+ / −", "Averaging up / down"],
    ["[ / ]", "Cursor down / up by Step"],
    ["Click canvas", "Tune to frequency"],
    ["Ctrl+Alt+N", "New session"],
    ["Ctrl+O", "Open session"],
    ["Ctrl+S / Ctrl+Shift+S", "Save / Save As"],
    ["Ctrl+Shift+C", "Copy image"],
    ["Ctrl+,", "Preferences"],
    ["Ctrl+Shift+F", "Fit to screen / restore"],
    ["Ctrl+Shift+M", "Minimize / restore"],
    ["Ctrl+Shift+H", "Hide / show"],
    ["Alt+F/E/T/H", "Open menu"],
  ];
  showDialog({
    title: "Keyboard Shortcuts",
    body: `<p>Single-key shortcuts are the original spectrum.js bindings and go
      through <code>Spectrum.prototype.onKeypress</code>.</p><table>${
      rows.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join("")
    }</table>`,
    buttons: [{ label: "Close", value: "ok", primary: true }],
  });
}

function embedGuide() {
  const origin = new URL(SPECTRUM_SRC, location.href).origin;
  showDialog({
    title: "Embedding Guide",
    body: `<p>Replace the original <code>spectrum.js</code> include with:</p>
<pre>&lt;script src="${esc(origin)}/dist/colormaps.js"&gt;&lt;/script&gt; &lt;!-- or your own --&gt;
&lt;script src="${esc(origin)}/dist/spectrum.js"&gt;&lt;/script&gt;</pre>
<p>The WebAssembly is embedded in that file. <code>new Spectrum(id, options)</code> and all
prototype methods behave as before. To be safe on engines that refuse synchronous
compilation, construct after <code>await Spectrum.ready</code>.</p>
<p>ES module build: <code>import Spectrum from "${esc(origin)}/dist/spectrum.mjs"</code>.</p>
<p>Load this test page against a build on another host with
<code>?src=https://host/dist/spectrum.js</code>. All responses from this server send
<code>Access-Control-Allow-Origin: *</code>.</p>
<p>Currently loaded from <code>${esc(SPECTRUM_SRC)}</code>.</p>`,
    buttons: [{ label: "Close", value: "ok", primary: true }],
  });
}

function about() {
  const S = state.impls.wasm;
  const mem = S?.core?.memoryBytes;
  showDialog({
    title: "About Spectrum WASM",
    body: `<p><strong>spectrum-wasm ${esc(S?.version ?? "?")}</strong>, a WebAssembly drop-in
replacement for <code>spectrum.js</code> (© 2019 Jeppe Ledet-Pedersen, MIT).</p>
<table>
<tr><td>Implementation</td><td>${esc(IMPL_LABEL[state.impl])}</td></tr>
<tr><td>Original available</td><td>${state.impls.original ? "yes" : "no"}</td></tr>
<tr><td>Wasm memory</td><td>${mem ? (mem / 1024).toFixed(0) + " KiB" : "—"}</td></tr>
<tr><td>Loaded from</td><td><code>${esc(SPECTRUM_SRC)}</code></td></tr>
<tr><td>Page origin</td><td><code>${esc(location.origin)}</code></td></tr>
</table>`,
    buttons: [{ label: "Close", value: "ok", primary: true }],
  });
}

async function benchmark() {
  if (!state.impls.original) {
    message("Original spectrum.js not available for comparison", 6000);
  }
  const stage = $("#bench-stage");
  const body = document.createElement("div");
  body.innerHTML = "<p>Running…</p>";
  const done = showDialog({
    title: "Benchmark",
    body,
    buttons: [{ label: "Close", value: "ok", primary: true }],
  });
  await new Promise((r) => setTimeout(r, 50));
  state.benchmarking = true;
  updateStatus();
  try {
    const sizes = [1024, 4096];
    const rows = [];
    for (const n of sizes) {
      const sig = createSignal({ bins: n }, 7);
      const frames = Array.from({ length: 8 }, (_, i) => sig.next(i * 33));
      const cases = Object.entries(state.impls)
        .filter(([, C]) => C)
        .map(([name, C]) => ({
          name,
          create() {
            const c = document.createElement("canvas");
            c.id = `bench_${name}`;
            stage.append(c);
            return new C(c.id, { centerHz: 10e6, spanHz: n * 1000, bins: n });
          },
        }));
      for (const r of runBenchmark(cases, frames, { iterations: 60, warmup: 15, rounds: 3 })) {
        rows.push({ n, ...r });
      }
      stage.replaceChildren();
    }
    stage.replaceChildren();
    const by = (n, name) => rows.find((r) => r.n === n && r.name === name);
    body.innerHTML = `<p>Best of 3 interleaved rounds, mean time per call on a 1024×600
      canvas, averaging 4, max hold on.
      <code>addData</code> includes canvas drawing (shared by both); <code>rowToImageData</code>
      is the per-bin waterfall kernel.</p>
      <table><tr><th>Bins</th><th>Implementation</th><th>addData</th><th>rowToImageData</th></tr>
      ${
      rows.map((r) =>
        `<tr><td>${r.n}</td><td>${IMPL_LABEL[r.name]}</td><td>${formatMs(r.addDataMs)}</td><td>${
          formatMs(r.waterfallMs)
        }</td></tr>`
      ).join("")
    }</table>
      ${
      state.impls.original
        ? `<p>${
          sizes.map((n) => {
            const o = by(n, "original"), w = by(n, "wasm");
            return `${n} bins: wasm is ${speedup(o.addDataMs, w.addDataMs).toFixed(2)}× overall, ${
              speedup(o.waterfallMs, w.waterfallMs).toFixed(2)
            }× on the waterfall kernel`;
          }).join("<br>")
        }</p>`
        : ""
    }`;
  } catch (e) {
    body.innerHTML = `<p>Benchmark failed:</p><pre>${esc(e.stack ?? e)}</pre>`;
  } finally {
    state.benchmarking = false;
  }
  await done;
}

// ---------------------------------------------------------------------------
// Theme, window, bars
// ---------------------------------------------------------------------------

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function setTheme(pref) {
  state.themePref = pref;
  savePref(safeStorage(), pref);
  applyTheme(document.documentElement, pref);
  syncMenus();
}

function setWindow(action) {
  state.win = reduceWindow(state.win, action);
  const app = $("#app");
  app.dataset.state = state.win.state;
  $("#show-pill").hidden = state.win.state !== "hidden";
  $("#btn-fit").title = state.win.state === "fit"
    ? "Restore (Ctrl+Shift+F)"
    : "Fit to screen (Ctrl+Shift+F)";
  closeMenus();
  if (state.win.state === "hidden") $("#show-pill").focus();
  updateStatus();
}

function toggleBar(which) {
  const app = $("#app");
  const cls = `no-${which}`;
  app.classList.toggle(cls);
  try {
    safeStorage()?.setItem(`spectrum-wasm.${cls}`, app.classList.contains(cls) ? "1" : "");
  } catch { /* storage unavailable */ }
  syncMenus();
}

function syncMenus() {
  const set = (cmd, on) =>
    $$(`[data-cmd="${cmd}"]`).forEach((b) => b.setAttribute("aria-checked", String(on)));
  set("impl.wasm", state.impl === "wasm");
  set("impl.original", state.impl === "original");
  $(`[data-cmd="impl.original"]`).disabled = !state.impls.original;
  for (const p of ["light", "dark", "system"]) set(`theme.${p}`, state.themePref === p);
  const app = $("#app");
  set("view.toolbar", !app.classList.contains("no-toolbar"));
  set("view.statusbar", !app.classList.contains("no-statusbar"));
  const tt = $("#theme-toggle");
  tt.dataset.pref = state.themePref;
  const resolved = resolveTheme(state.themePref, darkQuery.matches);
  tt.title = `Theme: ${
    { light: "Light", dark: "Dark", system: `Match System (${resolved})` }[state.themePref]
  } — click to change`;
}

function syncControls() {
  const sel = $("#colormap");
  const names = globalThis.colormapNames ?? [];
  if (sel.options.length !== (globalThis.colormaps?.length ?? 0)) {
    sel.replaceChildren(
      ...globalThis.colormaps.map((_, i) => new Option(names[i] ?? `Colormap ${i}`, String(i))),
    );
  }
  if (state.sp) {
    sel.value = String(state.sp.colorindex);
    $("#pause").textContent = state.sp.paused ? "Run" : "Pause";
    $("#max_hold").textContent = state.sp.maxHold ? "Norm" : "Max hold";
  }
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function openMenu(btn, focusFirst = false) {
  closeMenus(btn);
  btn.setAttribute("aria-expanded", "true");
  if (focusFirst) btn.nextElementSibling.querySelector("button:not(:disabled)")?.focus();
}

function closeMenus(except) {
  $$(".menu-btn").forEach((b) => b !== except && b.setAttribute("aria-expanded", "false"));
  $("#menubar").classList.remove("alt-hint");
}

function anyMenuOpen() {
  return $$(".menu-btn").some((b) => b.getAttribute("aria-expanded") === "true");
}

function wireMenus() {
  const btns = $$(".menu-btn");
  btns.forEach((btn, i) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.getAttribute("aria-expanded") === "true") closeMenus();
      else openMenu(btn);
    });
    btn.addEventListener("mouseenter", () => anyMenuOpen() && openMenu(btn));
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu(btn, true);
      } else if (e.key === "ArrowRight") btns[(i + 1) % btns.length].focus();
      else if (e.key === "ArrowLeft") btns[(i - 1 + btns.length) % btns.length].focus();
    });
    const pop = btn.nextElementSibling;
    pop.addEventListener("keydown", (e) => {
      const items = $$("button:not(:disabled)", pop);
      const idx = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") items[(idx + 1) % items.length].focus();
      else if (e.key === "ArrowUp") items[(idx - 1 + items.length) % items.length].focus();
      else if (e.key === "ArrowRight") {
        const nb = btns[(i + 1) % btns.length];
        openMenu(nb, true);
      } else if (e.key === "ArrowLeft") {
        const pb = btns[(i - 1 + btns.length) % btns.length];
        openMenu(pb, true);
      } else if (e.key === "Escape") {
        closeMenus();
        btn.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".menu")) closeMenus();
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const commands = {
  "file.new": fileNew,
  "file.open": fileOpen,
  "file.save": fileSave,
  "file.saveAs": fileSaveAs,
  "file.exportPng": exportPng,
  "edit.copyImage": copyImage,
  "edit.copySession": copySession,
  "edit.resetRange": () => state.sp.setRange(-120, 0, true),
  "edit.clearHolds": () => {
    state.sp.setMaxHold(state.sp.maxHold);
    message("Holds cleared");
  },
  "edit.preferences": preferences,
  "tools.pause": () => state.sp.togglePaused(),
  "tools.maxHold": () => state.sp.toggleMaxHold(),
  "tools.autoscale": () => {
    state.sp.forceAutoscale();
    message("Autoscaling on next frame");
  },
  "tools.colormap": () => state.sp.toggleColor(),
  "tools.fullscreen": () => state.sp.toggleFullscreen(),
  "tools.benchmark": benchmark,
  "impl.wasm": () => setImplementation("wasm"),
  "impl.original": () => setImplementation("original"),
  "theme.light": () => setTheme("light"),
  "theme.dark": () => setTheme("dark"),
  "theme.system": () => setTheme("system"),
  "theme.cycle": () => setTheme(nextPref(state.themePref)),
  "win.fit": () => setWindow("fit"),
  "win.minimize": () => setWindow("minimize"),
  "win.hide": () => setWindow("hide"),
  "win.show": () => setWindow("show"),
  "view.toolbar": () => toggleBar("toolbar"),
  "view.statusbar": () => toggleBar("statusbar"),
  "help.shortcuts": shortcuts,
  "help.embed": embedGuide,
  "help.about": about,
};

async function run(cmd) {
  const fn = commands[cmd];
  if (!fn) return;
  closeMenus();
  try {
    await fn();
  } catch (e) {
    message(`${cmd}: ${e.message}`, 8000);
    // deno-lint-ignore no-console
    console.error(e);
  }
  updateStatus();
}

function wireCommands() {
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.("[data-cmd]");
    if (!el || el.disabled) return;
    e.preventDefault();
    run(el.dataset.cmd);
  });
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

const CHORDS = {
  "ctrl+alt+n": "file.new",
  "ctrl+o": "file.open",
  "ctrl+s": "file.save",
  "ctrl+shift+s": "file.saveAs",
  "ctrl+shift+c": "edit.copyImage",
  "ctrl+,": "edit.preferences",
  "ctrl+shift+f": "win.fit",
  "ctrl+shift+m": "win.minimize",
  "ctrl+shift+h": "win.hide",
};

const ORIGINAL_KEYS = new Set([
  " ",
  "f",
  "c",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "s",
  "w",
  "+",
  "-",
  "m",
]);

function chordOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && e.key.length > 1 || e.shiftKey && /[a-z]/i.test(e.key)) parts.push("shift");
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  return parts.join("+");
}

function wireKeyboard() {
  globalThis.addEventListener("keydown", (e) => {
    if ($("#dialog").open) return;
    const chord = chordOf(e);
    if (chord === "ctrl+shift+h") {
      e.preventDefault();
      return setWindow("toggleHidden");
    }
    if (CHORDS[chord]) {
      e.preventDefault();
      return run(CHORDS[chord]);
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const idx = { f: 0, e: 1, t: 2, h: 3 }[e.key.toLowerCase()];
      if (idx !== undefined) {
        e.preventDefault();
        return openMenu($$(".menu-btn")[idx], true);
      }
      if (e.key === "Alt") $("#menubar").classList.add("alt-hint");
    }
    if (e.key === "Escape" && anyMenuOpen()) return closeMenus();

    const t = e.target;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.closest?.("input, select, textarea, .menu-pop, .menu-btn")) return;
    if (!state.sp || !isCanvasVisible(state.win)) return;

    if (e.key === "?") return run("help.shortcuts");
    if (e.key === "a") return run("tools.autoscale");
    if (e.key === "[") return state.sp.cursorDown();
    if (e.key === "]") return state.sp.cursorUp();
    if (ORIGINAL_KEYS.has(e.key)) {
      // Buttons would also react to Space; route it to the spectrum instead.
      e.preventDefault();
      state.sp.onKeypress(e);
      syncControls();
      updateStatus();
    }
  });
  globalThis.addEventListener("keyup", (e) => {
    if (e.key === "Alt") $("#menubar").classList.remove("alt-hint");
  });
}

// ---------------------------------------------------------------------------
// Canvas pointer
// ---------------------------------------------------------------------------

function pointerHz(e) {
  const sp = state.sp;
  const c = e.currentTarget;
  const rect = c.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (c.width / rect.width);
  return sp.bin_to_hz(sp.pixel_to_bin(x));
}

function wireCanvas() {
  const c = $("#waterfall");
  c.addEventListener("mousemove", (e) => {
    if (state.sp) state.pointerHz = pointerHz(e);
  });
  c.addEventListener("mouseleave", () => (state.pointerHz = NaN));
  c.addEventListener("click", (e) => {
    if (!state.sp) return;
    const hz = Math.round(pointerHz(e));
    state.sp.setFrequency(hz);
    state.sp.cursor_freq = hz;
    state.checkDirty = true;
    message(`Tuned to ${formatHz(hz, 4)}`);
    c.focus();
  });
}

function wireToolbarControls() {
  $("#colormap").addEventListener("change", (e) => state.sp?.setColormap(Number(e.target.value)));
  $("#cursor").addEventListener("change", () => state.sp?.cursorCheck());
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  applyTheme(document.documentElement, state.themePref);
  for (const cls of ["no-toolbar", "no-statusbar"]) {
    try {
      if (safeStorage()?.getItem(`spectrum-wasm.${cls}`)) $("#app").classList.add(cls);
    } catch { /* storage unavailable */ }
  }
  darkQuery.addEventListener?.("change", syncMenus);
  wireMenus();
  wireCommands();
  wireKeyboard();
  wireCanvas();
  wireToolbarControls();
  syncControls();
  syncMenus();
  setDirty(false);

  if (!globalThis.colormaps?.length) {
    message("colormaps.js did not load; no colormaps available", 0);
    return;
  }

  try {
    const [wasm, original] = await Promise.all([loadWasmImpl(), loadOriginalImpl()]);
    state.impls = { wasm, original };
  } catch (e) {
    message(`Failed to load spectrum-wasm: ${e.message}`, 0);
    const m = $("#viewport-msg");
    m.hidden = false;
    m.textContent = `Could not load ${SPECTRUM_SRC}`;
    return;
  }
  if (state.impl === "original" && !state.impls.original) state.impl = "wasm";
  syncMenus();
  quietly(createSpectrum);
  markSaved();
  message(
    state.impls.original
      ? "Ready: WebAssembly build loaded; original available under Tools"
      : "Ready: WebAssembly build loaded",
  );
  state.lastFrame = performance.now();
  frame();

  globalThis.addEventListener("beforeunload", (e) => {
    if (state.dirty) e.preventDefault();
  });
}

boot();
