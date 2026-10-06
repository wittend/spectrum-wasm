/**
 * Recording DOM / Canvas 2D mocks.
 *
 * Every context method call and property assignment is appended to a shared
 * log, with canvases replaced by stable tags and ImageData by a plain copy of
 * its pixels. Two Spectrum implementations driven through identical inputs
 * must therefore produce identical logs.
 */

// deno-lint-ignore no-explicit-any
export type Entry = any[];

export interface MockImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export class MockGradient {
  constructor(readonly id: number, private log: Entry[]) {}
  addColorStop(offset: number, color: string): void {
    this.log.push([`gradient${this.id}.addColorStop`, offset, color]);
  }
}

const CTX_PROPS = [
  "fillStyle",
  "strokeStyle",
  "font",
  "textBaseline",
  "textAlign",
  "imageSmoothingEnabled",
  "lineWidth",
] as const;

const CTX_METHODS = [
  "fillRect",
  "clearRect",
  "beginPath",
  "moveTo",
  "lineTo",
  "stroke",
  "fill",
  "save",
  "restore",
  "scale",
  "fillText",
] as const;

export class MockContext {
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
  private gradients = 0;

  constructor(readonly canvas: MockCanvas, private log: Entry[]) {
    const values: Record<string, unknown> = {};
    for (const p of CTX_PROPS) {
      Object.defineProperty(this, p, {
        get: () => values[p],
        set: (v) => {
          values[p] = v;
          this.log.push([`${canvas.tag}.${p}=`, describe(v)]);
        },
      });
    }
    for (const m of CTX_METHODS) {
      this[m] = (...args: unknown[]) => {
        this.log.push([`${canvas.tag}.${m}`, ...args.map(describe)]);
      };
    }
  }

  drawImage(...args: unknown[]): void {
    this.log.push([`${this.canvas.tag}.drawImage`, ...args.map(describe)]);
  }

  createImageData(w: number, h: number): MockImageData {
    this.log.push([`${this.canvas.tag}.createImageData`, w, h]);
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }

  putImageData(img: MockImageData, x: number, y: number): void {
    this.log.push([`${this.canvas.tag}.putImageData`, Array.from(img.data), x, y]);
  }

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): MockGradient {
    const g = new MockGradient(this.gradients++, this.log);
    this.log.push([`${this.canvas.tag}.createLinearGradient`, x0, y0, x1, y1]);
    return g;
  }
}

function describe(v: unknown): unknown {
  if (v instanceof MockCanvas) return `<canvas:${v.tag}>`;
  if (v instanceof MockGradient) return `<gradient${v.id}>`;
  return v;
}

export class MockCanvas {
  private _w = 300;
  private _h = 150;
  private ctx?: MockContext;
  clientWidth: number;
  clientHeight: number;
  fullscreenRequests = 0;

  constructor(readonly tag: string, private log: Entry[], clientW = 0, clientH = 0) {
    this.clientWidth = clientW;
    this.clientHeight = clientH;
  }

  get width(): number {
    return this._w;
  }
  set width(v: number) {
    this._w = v;
    this.log.push([`${this.tag}.width=`, v]);
  }
  get height(): number {
    return this._h;
  }
  set height(v: number) {
    this._h = v;
    this.log.push([`${this.tag}.height=`, v]);
  }

  getContext(kind: string): MockContext {
    if (kind !== "2d") throw new Error(`unsupported context ${kind}`);
    return (this.ctx ??= new MockContext(this, this.log));
  }

  requestFullscreen(): void {
    this.fullscreenRequests++;
    this.log.push([`${this.tag}.requestFullscreen`]);
  }
}

export interface MockElement {
  checked?: boolean;
  value?: string | number;
  textContent?: string;
}

export class MockDocument {
  readonly log: Entry[] = [];
  readonly elements: Record<string, MockElement | MockCanvas> = {};
  private created = 0;
  exitFullscreenCalls = 0;

  constructor(canvasId = "waterfall", clientW = 1024, clientH = 600) {
    this.elements[canvasId] = new MockCanvas("main", this.log, clientW, clientH);
    this.elements.check_live = { checked: true };
    this.elements.check_max = { checked: true };
    this.elements.check_min = { checked: true };
    this.elements.cursor = { checked: false };
    this.elements.colormap = { value: 0 };
    this.elements.pause = { textContent: "Pause" };
    this.elements.max_hold = { textContent: "Max hold" };
    this.elements.step = { value: "1000" };
  }

  getElementById(id: string): MockElement | MockCanvas | null {
    return this.elements[id] ?? null;
  }

  createElement(tag: string): MockCanvas {
    if (tag !== "canvas") throw new Error(`unsupported element ${tag}`);
    return new MockCanvas(`off${this.created++}`, this.log);
  }

  exitFullscreen(): void {
    this.exitFullscreenCalls++;
    this.log.push(["document.exitFullscreen"]);
  }

  /** Non-canvas element by id (test convenience). */
  el(id: string): MockElement {
    return this.elements[id] as MockElement;
  }

  get mainCanvas(): MockCanvas {
    return this.elements.waterfall as MockCanvas;
  }
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pseudo-random spectrum in roughly [-125, 5] dB. */
export function randomBins(n: number, rand: () => number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = -125 + rand() * 130;
  return out;
}
