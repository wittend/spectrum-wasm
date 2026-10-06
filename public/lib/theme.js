// @ts-check
/** Light / dark / follow-system theme preference. */

export const THEME_PREFS = /** @type {const} */ (["light", "dark", "system"]);
export const THEME_KEY = "spectrum-wasm.theme";

/** @typedef {"light" | "dark" | "system"} ThemePref */

/** @param {unknown} v @returns {ThemePref} */
export function normalizePref(v) {
  return THEME_PREFS.includes(/** @type {any} */ (v)) ? /** @type {ThemePref} */ (v) : "system";
}

/**
 * @param {ThemePref} pref @param {boolean} systemDark
 * @returns {"light" | "dark"}
 */
export function resolveTheme(pref, systemDark) {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

/** Cycle light -> dark -> system -> light. @param {ThemePref} pref */
export function nextPref(pref) {
  const i = THEME_PREFS.indexOf(pref);
  return THEME_PREFS[(i + 1) % THEME_PREFS.length];
}

/** @param {Storage | undefined} storage @returns {ThemePref} */
export function loadPref(storage) {
  try {
    return normalizePref(storage?.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** @param {Storage | undefined} storage @param {ThemePref} pref */
export function savePref(storage, pref) {
  try {
    storage?.setItem(THEME_KEY, pref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply to the document root. "system" removes the attribute so the
 * prefers-color-scheme media query decides.
 * @param {{ setAttribute(k: string, v: string): void, removeAttribute(k: string): void }} root
 * @param {ThemePref} pref
 */
export function applyTheme(root, pref) {
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}
