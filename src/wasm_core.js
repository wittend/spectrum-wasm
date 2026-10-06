// @ts-check
/**
 * Host-side wrapper around the spectrum_wasm module.
 *
 * Owns scratch buffers in wasm linear memory and copies JavaScript arrays in
 * and out of them. Every method takes and returns plain JS values / typed
 * arrays, so callers never deal with pointers.
 *
 * Views returned by `rowToRgba` and `fftPathY` alias wasm memory and are only
 * valid until the next call into the core.
 */

/**
 * @typedef {object} SpectrumExports
 * @property {WebAssembly.Memory} memory
 * @property {(bytes: number) => number} alloc
 * @property {(ptr: number, bytes: number) => void} dealloc
 * @property {(x: number) => number} js_round
 * @property {(x: number) => number} js_floor
 * @property {(x: number) => number} js_ceil
 * @property {(ptr: number, n: number) => number} array_max
 * @property {(ptr: number, n: number) => number} array_min
 * @property {(v: number, omin: number, omax: number, min: number, max: number) => number} squeeze
 * @property {(bin: number, len: number, min: number, max: number) => number} colormap_index
 * @property {(bins: number, n: number, cmap: number, len: number, min: number, max: number, out: number) => void} row_to_rgba
 * @property {(avg: number, bins: number, n: number, alpha: number) => void} average_update
 * @property {(max: number, bins: number, n: number, decay: number) => void} max_hold_update
 * @property {(min: number, bins: number, n: number) => void} min_hold_update
 * @property {(v: number, min: number, max: number, h: number) => number} db_to_y
 * @property {(bins: number, n: number, min: number, max: number, h: number, out: number) => void} fft_path_y
 * @property {(span: number, nbins: number) => number} axis_increment
 * @property {(start: number, inc: number) => number} axis_first_tick
 * @property {(v: number, inc: number) => number} autoscale_floor
 * @property {(v: number, inc: number) => number} autoscale_ceil
 * @property {(pixel: number, width: number, bins: number) => number} pixel_to_bin
 * @property {(bin: number, center: number, span: number, bins: number) => number} bin_to_hz
 * @property {(hz: number, center: number, span: number, bins: number) => number} hz_to_bin
 * @property {(freq: number, center: number, span: number) => number} limit_cursor
 * @property {(f: number, start: number, lo: number, hi: number, hzpp: number, out: number) => void} filter_rect
 */

/** A growable scratch block in wasm memory. */
class Scratch {
  /** @param {SpectrumExports} ex */
  constructor(ex) {
    this.ex = ex;
    this.ptr = 0;
    this.bytes = 0;
  }

  /**
   * Ensure capacity for `bytes` bytes and return the pointer.
   * @param {number} bytes
   */
  reserve(bytes) {
    if (bytes > this.bytes) {
      if (this.ptr) this.ex.dealloc(this.ptr, this.bytes);
      // Grow geometrically so a slowly increasing size doesn't thrash.
      const size = Math.max(bytes, this.bytes * 2, 64);
      this.ptr = this.ex.alloc(size);
      if (!this.ptr) throw new RangeError(`spectrum-wasm: out of memory (${size} bytes)`);
      this.bytes = size;
    }
    return this.ptr;
  }

  /** @param {number} n */
  f64(n) {
    const ptr = this.reserve(n * 8);
    return new Float64Array(this.ex.memory.buffer, ptr, n);
  }

  /** @param {number} n */
  u8(n) {
    const ptr = this.reserve(n);
    return new Uint8Array(this.ex.memory.buffer, ptr, n);
  }
}

export class SpectrumCore {
  /** @param {WebAssembly.Instance} instance */
  constructor(instance) {
    /** @type {SpectrumExports} */
    this.ex = /** @type {any} */ (instance.exports);
    this._a = new Scratch(this.ex); // primary input (bins)
    this._b = new Scratch(this.ex); // state (avg / max / min) or output
    this._c = new Scratch(this.ex); // colormap
    this._d = new Scratch(this.ex); // rgba output
    this._e = new Scratch(this.ex); // small fixed outputs
    /** @type {unknown} */
    this._cmapRef = null;
    this._cmapLen = 0;
  }

  /** Total bytes of wasm linear memory in use. */
  get memoryBytes() {
    return this.ex.memory.buffer.byteLength;
  }

  /**
   * Copy an array-like of numbers into scratch block `s`.
   * @param {Scratch} s
   * @param {ArrayLike<number>} arr
   */
  _load(s, arr) {
    const n = arr.length;
    const view = s.f64(n);
    view.set(/** @type {ArrayLike<number>} */ (arr));
    return view;
  }

  // ---- JS Math semantics -------------------------------------------------

  /** @param {number} x */
  round(x) {
    return this.ex.js_round(x);
  }
  /** @param {number} x */
  floor(x) {
    return this.ex.js_floor(x);
  }
  /** @param {number} x */
  ceil(x) {
    return this.ex.js_ceil(x);
  }

  /** `Math.max(...arr)` @param {ArrayLike<number>} arr */
  arrayMax(arr) {
    const v = this._load(this._a, arr);
    return this.ex.array_max(this._a.ptr, v.length);
  }

  /** `Math.min(...arr)` @param {ArrayLike<number>} arr */
  arrayMin(arr) {
    const v = this._load(this._a, arr);
    return this.ex.array_min(this._a.ptr, v.length);
  }

  // ---- Spectrum kernels --------------------------------------------------

  /**
   * @param {number} value @param {number} outMin @param {number} outMax
   * @param {number} minDb @param {number} maxDb
   */
  squeeze(value, outMin, outMax, minDb, maxDb) {
    return this.ex.squeeze(value, outMin, outMax, minDb, maxDb);
  }

  /**
   * @param {number} bin @param {number} cmapLen
   * @param {number} wfMinDb @param {number} wfMaxDb
   */
  colormapIndex(bin, cmapLen, wfMinDb, wfMaxDb) {
    return this.ex.colormap_index(bin, cmapLen, wfMinDb, wfMaxDb);
  }

  /**
   * Upload a colormap (array of [r,g,b]) if it differs from the cached one.
   * Values are coerced exactly like an assignment into ImageData.data
   * (Uint8ClampedArray: clamp, round-half-to-even).
   * @param {ArrayLike<ArrayLike<number>>} colormap
   */
  setColormap(colormap) {
    if (colormap === this._cmapRef && colormap.length === this._cmapLen) return;
    const n = colormap.length;
    // RGBA with alpha pre-set so the kernel copies one u32 per pixel.
    const packed = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const c = colormap[i];
      packed[i * 4] = c[0];
      packed[i * 4 + 1] = c[1];
      packed[i * 4 + 2] = c[2];
      packed[i * 4 + 3] = 255;
    }
    this._c.u8(n * 4).set(packed);
    this._cmapRef = colormap;
    this._cmapLen = n;
  }

  /** Force the next `setColormap` to re-upload (after in-place edits). */
  invalidateColormap() {
    this._cmapRef = null;
  }

  /**
   * Map bins to RGBA using the current colormap.
   * @param {ArrayLike<number>} bins
   * @param {number} wfMinDb @param {number} wfMaxDb
   * @returns {Uint8Array} view of length 4*bins.length
   */
  rowToRgba(bins, wfMinDb, wfMaxDb) {
    const n = bins.length;
    this._d.u8(n * 4);
    this._load(this._a, bins);
    this.ex.row_to_rgba(
      this._a.ptr,
      n,
      this._c.ptr,
      this._cmapLen,
      wfMinDb,
      wfMaxDb,
      this._d.ptr,
    );
    // Re-create in case memory grew while loading.
    return new Uint8Array(this.ex.memory.buffer, this._d.ptr, n * 4);
  }

  /**
   * In-place exponential average of `avg` toward `bins`.
   * @param {Float64Array | number[]} avg
   * @param {ArrayLike<number>} bins
   * @param {number} alpha
   */
  averageUpdate(avg, bins, alpha) {
    const n = bins.length;
    this._load(this._a, bins);
    this._load(this._b, avg);
    this.ex.average_update(this._b.ptr, this._a.ptr, n, alpha);
    copyOut(avg, this.ex.memory.buffer, this._b.ptr, n);
  }

  /**
   * In-place max hold with decay.
   * @param {Float64Array | number[]} max
   * @param {ArrayLike<number>} bins
   * @param {number} decay
   */
  maxHoldUpdate(max, bins, decay) {
    const n = bins.length;
    this._load(this._a, bins);
    this._load(this._b, max);
    this.ex.max_hold_update(this._b.ptr, this._a.ptr, n, decay);
    copyOut(max, this.ex.memory.buffer, this._b.ptr, n);
  }

  /**
   * In-place min hold.
   * @param {Float64Array | number[]} min
   * @param {ArrayLike<number>} bins
   */
  minHoldUpdate(min, bins) {
    const n = bins.length;
    this._load(this._a, bins);
    this._load(this._b, min);
    this.ex.min_hold_update(this._b.ptr, this._a.ptr, n);
    copyOut(min, this.ex.memory.buffer, this._b.ptr, n);
  }

  /**
   * @param {number} value @param {number} minDb @param {number} maxDb
   * @param {number} spectrumHeight
   */
  dbToY(value, minDb, maxDb, spectrumHeight) {
    return this.ex.db_to_y(value, minDb, maxDb, spectrumHeight);
  }

  /**
   * Y coordinate of each bin for the FFT trace.
   * @param {ArrayLike<number>} bins
   * @param {number} minDb @param {number} maxDb @param {number} spectrumHeight
   * @returns {Float64Array} view of length bins.length
   */
  fftPathY(bins, minDb, maxDb, spectrumHeight) {
    const n = bins.length;
    this._load(this._a, bins);
    this._b.f64(n);
    this.ex.fft_path_y(this._a.ptr, n, minDb, maxDb, spectrumHeight, this._b.ptr);
    return new Float64Array(this.ex.memory.buffer, this._b.ptr, n);
  }

  /** @param {number} spanHz @param {number} nbins */
  axisIncrement(spanHz, nbins) {
    return this.ex.axis_increment(spanHz, nbins);
  }

  /** @param {number} startFreq @param {number} inc */
  axisFirstTick(startFreq, inc) {
    return this.ex.axis_first_tick(startFreq, inc);
  }

  /** @param {number} v @param {number} inc */
  autoscaleFloor(v, inc) {
    return this.ex.autoscale_floor(v, inc);
  }

  /** @param {number} v @param {number} inc */
  autoscaleCeil(v, inc) {
    return this.ex.autoscale_ceil(v, inc);
  }

  /** @param {number} pixel @param {number} width @param {number} bins */
  pixelToBin(pixel, width, bins) {
    return this.ex.pixel_to_bin(pixel, width, bins);
  }

  /** @param {number} bin @param {number} centerHz @param {number} spanHz @param {number} bins */
  binToHz(bin, centerHz, spanHz, bins) {
    return this.ex.bin_to_hz(bin, centerHz, spanHz, bins);
  }

  /** @param {number} hz @param {number} centerHz @param {number} spanHz @param {number} bins */
  hzToBin(hz, centerHz, spanHz, bins) {
    return this.ex.hz_to_bin(hz, centerHz, spanHz, bins);
  }

  /** @param {number} freq @param {number} centerHz @param {number} spanHz */
  limitCursor(freq, centerHz, spanHz) {
    return this.ex.limit_cursor(freq, centerHz, spanHz);
  }

  /**
   * @param {number} frequency @param {number} startFreq
   * @param {number} filterLow @param {number} filterHigh @param {number} hzPerPixel
   * @returns {[number, number]} [x, width]
   */
  filterRect(frequency, startFreq, filterLow, filterHigh, hzPerPixel) {
    this._e.f64(2);
    this.ex.filter_rect(frequency, startFreq, filterLow, filterHigh, hzPerPixel, this._e.ptr);
    const v = new Float64Array(this.ex.memory.buffer, this._e.ptr, 2);
    return [v[0], v[1]];
  }
}

/**
 * @param {Float64Array | number[]} dst
 * @param {ArrayBufferLike} buffer @param {number} ptr @param {number} n
 */
function copyOut(dst, buffer, ptr, n) {
  const src = new Float64Array(buffer, ptr, n);
  if (dst instanceof Float64Array) {
    dst.set(src);
  } else {
    for (let i = 0; i < n; i++) dst[i] = src[i];
  }
}

/**
 * Synchronously instantiate the core. Browsers may refuse synchronous
 * compilation of large modules on the main thread; callers should fall back
 * to `createSpectrumCoreAsync`.
 * @param {BufferSource | WebAssembly.Module} source
 */
export function createSpectrumCore(source) {
  const mod = source instanceof WebAssembly.Module ? source : new WebAssembly.Module(source);
  return new SpectrumCore(new WebAssembly.Instance(mod, {}));
}

/**
 * Asynchronously instantiate the core from bytes, a Response, or a URL.
 * @param {BufferSource | Response | Promise<Response> | string | URL} source
 */
export async function createSpectrumCoreAsync(source) {
  if (typeof source === "string" || source instanceof URL) {
    source = fetch(source);
  }
  if (
    source instanceof Promise || (typeof Response !== "undefined" && source instanceof Response)
  ) {
    const res = await source;
    if (!res.ok) throw new Error(`spectrum-wasm: failed to load wasm (${res.status})`);
    const bytes = await res.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return new SpectrumCore(instance);
  }
  const { instance } = await WebAssembly.instantiate(/** @type {BufferSource} */ (source), {});
  return new SpectrumCore(instance);
}

/**
 * Decode base64 to bytes (works in browsers and Deno).
 * @param {string} b64
 */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
