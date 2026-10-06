// @ts-check
/**
 * Window state for the test interface frame.
 *
 *   normal    — floating window inside the page (user-resizable)
 *   fit       — fills the viewport
 *   minimized — collapsed to its title bar, docked bottom-left
 *   hidden    — not shown at all; a small "Show" button remains
 *
 * `restore` remembers the last visible, non-minimized layout so un-minimize
 * and un-hide return to it.
 */

/** @typedef {"normal" | "fit" | "minimized" | "hidden"} WinState */
/** @typedef {{ state: WinState, restore: "normal" | "fit" }} Win */
/** @typedef {"fit" | "minimize" | "hide" | "show" | "toggleHidden" | "normal"} WinAction */

export const WIN_STATES = /** @type {const} */ (["normal", "fit", "minimized", "hidden"]);

/** @returns {Win} */
export function initialWindow() {
  return { state: "normal", restore: "normal" };
}

/**
 * @param {Win} win
 * @param {WinAction} action
 * @returns {Win}
 */
export function reduceWindow(win, action) {
  switch (action) {
    case "fit":
      // Toggle between fit and normal; from minimized/hidden go straight to fit.
      if (win.state === "fit") return { state: "normal", restore: "normal" };
      return { state: "fit", restore: "fit" };
    case "normal":
      return { state: "normal", restore: "normal" };
    case "minimize":
      if (win.state === "minimized") return { state: win.restore, restore: win.restore };
      return { state: "minimized", restore: win.restore };
    case "hide":
      return { state: "hidden", restore: win.restore };
    case "show":
      return win.state === "hidden" ? { state: win.restore, restore: win.restore } : win;
    case "toggleHidden":
      return reduceWindow(win, win.state === "hidden" ? "show" : "hide");
    default:
      return win;
  }
}

/** Whether the spectrum canvas is on screen (worth feeding frames). @param {Win} win */
export function isCanvasVisible(win) {
  return win.state === "normal" || win.state === "fit";
}
