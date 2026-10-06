// @ts-check
/**
 * The test interface's "document": a session file holding every Spectrum
 * setting plus the synthetic signal configuration. New / Save / Save As
 * operate on this.
 */

export const SESSION_VERSION = 1;
export const SESSION_EXT = ".spectrum.json";
export const UNTITLED = `untitled${SESSION_EXT}`;

/**
 * @typedef {object} Session
 * @property {number} version
 * @property {number} centerHz
 * @property {number} spanHz
 * @property {number} lowHz
 * @property {number} highHz
 * @property {number} minDb
 * @property {number} maxDb
 * @property {number} wfMinDb
 * @property {number} wfMaxDb
 * @property {number} colormap
 * @property {number} averaging
 * @property {number} decay
 * @property {boolean} maxHold
 * @property {number} spectrumPercent
 * @property {number} frequency
 * @property {number} filterLow
 * @property {number} filterHigh
 * @property {number} bins
 * @property {number} fps
 * @property {number} noiseFloor
 */

/** @returns {Session} */
export function defaultSession() {
  return {
    version: SESSION_VERSION,
    centerHz: 10_000_000,
    spanHz: 1_024_000,
    lowHz: 9_488_000,
    highHz: 10_512_000,
    minDb: -120,
    maxDb: 0,
    wfMinDb: -120,
    wfMaxDb: 0,
    colormap: 0,
    averaging: 0,
    decay: 1,
    maxHold: false,
    spectrumPercent: 50,
    frequency: 10_000_000,
    filterLow: -3000,
    filterHigh: 3000,
    bins: 1024,
    fps: 30,
    noiseFloor: -105,
  };
}

/** Numeric field limits: [min, max, integer?] */
const LIMITS = {
  centerHz: [0, 1e12, false],
  spanHz: [1, 1e11, false],
  lowHz: [-1e12, 1e12, false],
  highHz: [-1e12, 1e12, false],
  minDb: [-300, 100, false],
  maxDb: [-300, 100, false],
  wfMinDb: [-300, 100, false],
  wfMaxDb: [-300, 100, false],
  colormap: [0, 1000, true],
  averaging: [0, 1000, true],
  decay: [0, 2, false],
  spectrumPercent: [0, 100, false],
  frequency: [-1e12, 1e12, false],
  filterLow: [-1e9, 1e9, false],
  filterHigh: [-1e9, 1e9, false],
  bins: [16, 65536, true],
  fps: [1, 240, false],
  noiseFloor: [-140, -10, false],
};

/**
 * @param {unknown} v @param {number} fallback
 * @param {number} min @param {number} max @param {boolean} int
 */
function num(v, fallback, min, max, int) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(max, Math.max(min, n));
  return int ? Math.round(c) : c;
}

/**
 * Validate an untrusted object into a Session, filling gaps with defaults and
 * clamping out-of-range values. Also repairs inverted ranges.
 * @param {unknown} raw
 * @returns {Session}
 */
export function normalizeSession(raw) {
  const d = defaultSession();
  const src = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, unknown>} */
  const out = { version: SESSION_VERSION };
  for (const [key, [min, max, int]] of Object.entries(LIMITS)) {
    out[key] = num(
      src[key],
      /** @type {number} */ (d[/** @type {keyof Session} */ (key)]),
      /** @type {number} */ (min),
      /** @type {number} */ (max),
      /** @type {boolean} */ (int),
    );
  }
  out.maxHold = src.maxHold === true;
  const s = /** @type {Session} */ (out);
  if (s.maxDb <= s.minDb) [s.minDb, s.maxDb] = [d.minDb, d.maxDb];
  if (s.wfMaxDb <= s.wfMinDb) [s.wfMinDb, s.wfMaxDb] = [s.minDb, s.maxDb];
  if (s.filterHigh < s.filterLow) [s.filterLow, s.filterHigh] = [s.filterHigh, s.filterLow];
  return s;
}

/**
 * Parse session file text.
 * @param {string} text
 * @returns {Session}
 * @throws {SyntaxError} on invalid JSON
 */
export function parseSession(text) {
  return normalizeSession(JSON.parse(text));
}

/** @param {Session} session */
export function serializeSession(session) {
  return JSON.stringify(normalizeSession(session), null, 2) + "\n";
}

/**
 * Capture the current state of a Spectrum instance (original or wasm).
 * @param {any} sp
 * @param {{ bins: number, fps: number, noiseFloor: number }} extra
 * @returns {Session}
 */
export function sessionFromSpectrum(sp, extra) {
  return normalizeSession({
    centerHz: sp.centerHz,
    spanHz: sp.spanHz,
    lowHz: sp.lowHz,
    highHz: sp.highHz,
    minDb: sp.min_db,
    maxDb: sp.max_db,
    wfMinDb: sp.wf_min_db,
    wfMaxDb: sp.wf_max_db,
    colormap: sp.colorindex,
    averaging: sp.averaging,
    decay: sp.decay,
    maxHold: sp.maxHold,
    spectrumPercent: sp.spectrumPercent,
    frequency: sp.frequency,
    filterLow: sp.filter_low,
    filterHigh: sp.filter_high,
    ...extra,
  });
}

/**
 * Apply a session to a Spectrum instance using only its public methods.
 * @param {any} sp
 * @param {Session} s
 */
export function applySessionToSpectrum(sp, s) {
  sp.setCenterHz(s.centerHz);
  sp.setSpanHz(s.spanHz);
  sp.setLowHz(s.lowHz);
  sp.setHighHz(s.highHz);
  sp.setRange(s.wfMinDb, s.wfMaxDb, true);
  sp.setRange(s.minDb, s.maxDb, false);
  sp.setColormap(s.colormap);
  sp.setAveraging(s.averaging);
  sp.setDecay(s.decay);
  if (Boolean(sp.maxHold) !== s.maxHold) sp.setMaxHold(s.maxHold);
  sp.setSpectrumPercent(s.spectrumPercent);
  sp.setFrequency(s.frequency);
  sp.setFilter(s.filterLow, s.filterHigh);
}

/**
 * Ensure a user-entered file name ends in .spectrum.json and has no path.
 * @param {string} name
 */
export function sessionFileName(name) {
  let base = String(name ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  // deno-lint-ignore no-control-regex
  base = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_");
  if (!base) return UNTITLED;
  if (base.endsWith(SESSION_EXT)) return base;
  if (base.endsWith(".json")) base = base.slice(0, -5);
  return base + SESSION_EXT;
}
