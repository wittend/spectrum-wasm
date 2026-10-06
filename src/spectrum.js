// @ts-nocheck -- mirrors the untyped original; behaviour is pinned by tests.
// deno-lint-ignore-file eqeqeq camelcase
/*
 * Port of spectrum.js (Copyright (c) 2019 Jeppe Ledet-Pedersen, MIT license)
 * with the per-bin numeric work moved into WebAssembly.
 *
 * Public surface (constructor signature, prototype methods, instance fields,
 * and the DOM ids / globals it touches) is kept identical to the original so
 * this can replace it with a one-line <script> change. Canvas drawing stays in
 * JavaScript because the 2D context is only reachable from JS; the wasm core
 * computes everything that iterates over bins.
 *
 * Differences from the original, all deliberate:
 *  - binsAverage / binsMax / binsMin are Float64Array instead of Array.
 *  - autoscale with max hold enabled before the first frame no longer throws.
 *  - rowToImageData never logs: NaN bins map to the last colormap entry, which
 *    is what the original's catch block painted.
 */

/**
 * Build the Spectrum constructor bound to a wasm core.
 *
 * @param {{ core: import("./wasm_core.js").SpectrumCore | null }} ref
 *   Holder for the core; may be filled in after definition (async init).
 * @param {typeof globalThis} [host] Global object supplying `document` and
 *   `colormaps`, looked up at call time exactly like the original.
 */
export function defineSpectrum(ref, host = globalThis) {
  function core() {
    const c = ref.core;
    if (!c) {
      throw new Error("spectrum-wasm: WebAssembly core not ready; await Spectrum.ready first");
    }
    return c;
  }

  function colormaps() {
    return host.colormaps;
  }

  function document() {
    return host.document;
  }

  Spectrum.prototype.setFrequency = function (freq) {
    this.frequency = freq;
  };

  Spectrum.prototype.setFilter = function (low, high) {
    this.filter_low = low;
    this.filter_high = high;
  };

  Spectrum.prototype.squeeze = function (value, out_min, out_max) {
    return core().squeeze(value, out_min, out_max, this.min_db, this.max_db);
  };

  Spectrum.prototype.rowToImageData = function (bins) {
    const c = core();
    const data = this.imagedata.data;
    const n = data.length >> 2;
    if (this.colormap.length === 0) {
      throw new TypeError("spectrum-wasm: colormap is empty");
    }
    c.setColormap(this.colormap);
    // The original iterated over imagedata pixels and read bins[i]; pad or
    // trim so a length mismatch behaves the same (undefined -> NaN).
    let src = bins;
    if (bins.length !== n) {
      src = new Float64Array(n);
      for (let i = 0; i < n; i++) src[i] = bins[i];
    }
    data.set(c.rowToRgba(src, this.wf_min_db, this.wf_max_db));
  };

  Spectrum.prototype.addWaterfallRow = function (bins) {
    // Shift waterfall 1 row down
    this.ctx_wf.drawImage(
      this.ctx_wf.canvas,
      0,
      0,
      this.wf_size,
      this.wf_rows - 1,
      0,
      1,
      this.wf_size,
      this.wf_rows - 1,
    );

    // Draw new line on waterfall canvas
    this.rowToImageData(bins);
    this.ctx_wf.putImageData(this.imagedata, 0, 0);

    const width = this.ctx.canvas.width;
    const height = this.ctx.canvas.height;

    // Copy scaled FFT canvas to screen. Only copy the number of rows that will
    // fit in waterfall area to avoid vertical scaling.
    this.ctx.imageSmoothingEnabled = false;
    const rows = Math.min(this.wf_rows, height - this.spectrumHeight);
    this.ctx.drawImage(
      this.ctx_wf.canvas,
      0,
      0,
      this.wf_size,
      rows,
      0,
      this.spectrumHeight,
      width,
      height - this.spectrumHeight,
    );
  };

  Spectrum.prototype.drawFFT = function (bins, color) {
    const ys = core().fftPathY(bins, this.min_db, this.max_db, this.spectrumHeight);
    const ctx = this.ctx;
    const last = bins.length - 1;
    ctx.beginPath();
    ctx.moveTo(-1, this.spectrumHeight + 1);
    for (let i = 0; i <= last; i++) {
      const s = ys[i];
      if (i == 0) ctx.lineTo(-1, s);
      ctx.lineTo(i, s);
      if (i == last) ctx.lineTo(this.wf_size + 1, s);
    }
    ctx.lineTo(this.wf_size + 1, this.spectrumHeight + 1);
    ctx.strokeStyle = color;
    ctx.stroke();
  };

  Spectrum.prototype.drawFilter = function (bins) {
    const hz_per_pixel = this.spanHz / bins.length;
    const [x, width] = core().filterRect(
      this.frequency,
      this.start_freq,
      this.filter_low,
      this.filter_high,
      hz_per_pixel,
    );
    this.ctx.fillStyle = "#404040";
    this.ctx.fillRect(x, 0, width, this.spectrumHeight);
  };

  Spectrum.prototype.drawCursor = function (f, bins, color, amp) {
    const hz_per_pixel = this.spanHz / bins.length;

    // draw vertical line
    const x = (f - this.start_freq) / hz_per_pixel;
    this.ctx.beginPath();
    this.ctx.moveTo(x, 0);
    this.ctx.lineTo(x, this.spectrumHeight);

    if (typeof amp !== "undefined") {
      const s = core().dbToY(amp, this.min_db, this.max_db, this.spectrumHeight);
      this.ctx.moveTo(x - 10, s);
      this.ctx.lineTo(x + 10, s);
    }

    this.ctx.strokeStyle = color;
    this.ctx.stroke();
  };

  Spectrum.prototype.drawSpectrum = function (bins) {
    const c = core();
    const width = this.ctx.canvas.width;
    const height = this.ctx.canvas.height;

    // Fill with black
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, width, height);

    // FFT averaging
    if (this.averaging > 0) {
      if (!this.binsAverage || this.binsAverage.length != bins.length) {
        this.binsAverage = Float64Array.from(bins);
      } else {
        c.averageUpdate(this.binsAverage, bins, this.alpha);
      }
      bins = this.binsAverage;
    }

    // Max hold
    if (this.maxHold) {
      if (!this.binsMax || this.binsMax.length != bins.length) {
        this.binsMax = Float64Array.from(bins);
      } else {
        c.maxHoldUpdate(this.binsMax, bins, this.decay);
      }
    }

    // Min hold (gated on maxHold, as in the original)
    if (this.maxHold) {
      if (!this.binsMin || this.binsMin.length != bins.length) {
        this.binsMin = Float64Array.from(bins);
      } else {
        c.minHoldUpdate(this.binsMin, bins);
      }
    }

    // Do not draw anything if spectrum is not visible
    if (this.ctx_axes.canvas.height < 1) {
      return;
    }
    // Scale for FFT
    this.ctx.save();
    this.ctx.scale(width / this.wf_size, 1);

    // draw filter band
    this.drawFilter(bins);

    // draw pointer
    this.drawCursor(this.frequency, bins, "#ff0000", bins[this.hz_to_bin(this.frequency)]);

    // draw cursor
    if (this.cursor_active) {
      this.drawCursor(this.cursor_freq, bins, "#00ffff", bins[this.hz_to_bin(this.cursor_freq)]);
    }

    const doc = document();

    // Draw maxhold
    if (this.maxHold && true == doc.getElementById("check_max").checked) {
      this.ctx.fillStyle = "none";
      this.drawFFT(this.binsMax, "#ffff00");
    }

    if (true == doc.getElementById("check_live").checked) {
      // Draw FFT bins
      this.drawFFT(bins, "#ffffff");
      // Fill scaled path
      this.ctx.fillStyle = this.gradient;
      this.ctx.fill();
    }

    // Draw minhold
    if (this.maxHold && true == doc.getElementById("check_min").checked) {
      this.ctx.fillStyle = "none";
      this.drawFFT(this.binsMin, "#ff0000");
    }

    // Restore scale
    this.ctx.restore();

    // Copy axes from offscreen canvas
    this.ctx.drawImage(this.ctx_axes.canvas, 0, 0);
  };

  Spectrum.prototype.updateAxes = function () {
    const c = core();
    const width = this.ctx_axes.canvas.width;
    const height = this.ctx_axes.canvas.height;

    // Clear axes canvas
    this.ctx_axes.clearRect(0, 0, width, height);

    this.start_freq = this.centerHz - (this.spanHz / 2);
    const hz_per_pixel = this.spanHz / width;

    // Draw axes
    this.ctx_axes.font = "12px sans-serif";
    this.ctx_axes.fillStyle = "white";
    this.ctx_axes.textBaseline = "middle";

    this.ctx_axes.textAlign = "left";
    const step = 10;
    for (let i = this.min_db + 10; i <= this.max_db - 10; i += step) {
      const y = height - this.squeeze(i, 0, height);
      this.ctx_axes.fillText(i, 5, y);

      this.ctx_axes.beginPath();
      this.ctx_axes.moveTo(20, y);
      this.ctx_axes.lineTo(width, y);
      this.ctx_axes.strokeStyle = "rgba(200, 200, 200, 0.30)";
      this.ctx_axes.stroke();
    }

    this.ctx_axes.textBaseline = "top";

    const inc = c.axisIncrement(this.spanHz, this.nbins);

    let freq = c.axisFirstTick(this.start_freq, inc);
    let text;
    while (freq <= this.highHz) {
      this.ctx_axes.textAlign = "center";
      const x = (freq - this.start_freq) / hz_per_pixel;
      text = freq / 1e6;
      this.ctx_axes.fillText(text.toFixed(3), x, 2);
      this.ctx_axes.beginPath();
      this.ctx_axes.moveTo(x, 0);
      this.ctx_axes.lineTo(x, height);
      this.ctx_axes.strokeStyle = "rgba(200, 200, 200, 0.30)";
      this.ctx_axes.stroke();
      freq = freq + inc;
    }
  };

  Spectrum.prototype.addData = function (data) {
    if (!this.paused) {
      if (data.length != this.wf_size) {
        this.wf_size = data.length;
        this.ctx_wf.canvas.width = data.length;
        this.ctx_wf.fillStyle = "black";
        this.ctx_wf.fillRect(0, 0, this.wf.width, this.wf.height);
        this.imagedata = this.ctx_wf.createImageData(data.length, 1);
      }
      this.bin_copy = data;
      this.nbins = data.length;

      // autoscale based on the min/max of the current spectrum or the current
      // max hold (if it's turned on), in 5 dB increments
      if (this.autoscale) {
        this.autoscale = false;
        const c = core();
        const increment = 5.0;
        let data_max = c.arrayMax(data);
        let data_min = c.arrayMin(data);
        if (this.maxHold && this.binsMax) {
          // autoscale off peak bins in max hold mode
          data_max = Math.max(c.arrayMax(this.binsMax), data_max);
          data_min = Math.min(c.arrayMin(this.binsMax), data_min);
        }
        this.setRange(
          c.autoscaleFloor(data_min, increment),
          c.autoscaleCeil(data_max, increment),
          true,
        );
      }
      this.drawSpectrum(data);
      this.addWaterfallRow(data);
      this.resize();
    }
  };

  Spectrum.prototype.updateSpectrumRatio = function () {
    this.spectrumHeight = Math.round(this.canvas.height * this.spectrumPercent / 100.0);

    this.gradient = this.ctx.createLinearGradient(0, 0, 0, this.spectrumHeight);
    for (let i = 0; i < this.colormap.length; i++) {
      const c = this.colormap[this.colormap.length - 1 - i];
      this.gradient.addColorStop(
        i / this.colormap.length,
        "rgba(" + c[0] + "," + c[1] + "," + c[2] + ", 1.0)",
      );
    }
    this.saveSettings();
  };

  Spectrum.prototype.resize = function () {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;

    if (this.canvas.width != width || this.canvas.height != height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.updateSpectrumRatio();
    }

    if (this.axes.width != width || this.axes.height != this.spectrumHeight) {
      this.axes.width = width;
      this.axes.height = this.spectrumHeight;
      this.updateAxes();
    }
    this.saveSettings();
  };

  Spectrum.prototype.setSpectrumPercent = function (percent) {
    if (percent >= 0 && percent <= 100) {
      this.spectrumPercent = percent;
      this.updateSpectrumRatio();
    }
    this.saveSettings();
  };

  Spectrum.prototype.incrementSpectrumPercent = function () {
    if (this.spectrumPercent + this.spectrumPercentStep <= 100) {
      this.setSpectrumPercent(this.spectrumPercent + this.spectrumPercentStep);
    }
    this.saveSettings();
  };

  Spectrum.prototype.decrementSpectrumPercent = function () {
    if (this.spectrumPercent - this.spectrumPercentStep >= 0) {
      this.setSpectrumPercent(this.spectrumPercent - this.spectrumPercentStep);
    }
    this.saveSettings();
  };

  Spectrum.prototype.setColormap = function (value) {
    const maps = colormaps();
    this.colorindex = value;
    if (this.colorindex >= maps.length) this.colorindex = 0;
    this.colormap = maps[this.colorindex];
    this.updateSpectrumRatio();
    this.saveSettings();
  };

  Spectrum.prototype.toggleColor = function () {
    const maps = colormaps();
    this.colorindex++;
    if (this.colorindex >= maps.length) this.colorindex = 0;
    this.colormap = maps[this.colorindex];
    this.updateSpectrumRatio();
    document().getElementById("colormap").value = this.colorindex;
    this.saveSettings();
  };

  Spectrum.prototype.setRange = function (min_db, max_db, adjust_waterfall) {
    this.min_db = min_db;
    this.max_db = max_db;
    if (adjust_waterfall) {
      this.wf_min_db = min_db;
      this.wf_max_db = max_db;
    }
    this.updateAxes();
    this.saveSettings();
  };

  Spectrum.prototype.positionUp = function () {
    this.setRange(this.min_db - 5, this.max_db - 5, false);
    this.saveSettings();
  };

  Spectrum.prototype.positionDown = function () {
    this.setRange(this.min_db + 5, this.max_db + 5, false);
    this.saveSettings();
  };

  Spectrum.prototype.rangeIncrease = function () {
    this.setRange(this.min_db, this.max_db + 5, true);
    this.saveSettings();
  };

  Spectrum.prototype.rangeDecrease = function () {
    if (this.max_db - this.min_db > 10) this.setRange(this.min_db, this.max_db - 5, true);
    this.saveSettings();
  };

  Spectrum.prototype.setCenterHz = function (hz) {
    this.centerHz = hz;
    this.updateAxes();
    this.saveSettings();
  };

  Spectrum.prototype.setSpanHz = function (hz) {
    this.spanHz = hz;
    this.updateAxes();
    this.saveSettings();
  };

  Spectrum.prototype.setLowHz = function (hz) {
    this.lowHz = hz;
    this.updateAxes();
    this.saveSettings();
  };

  Spectrum.prototype.setHighHz = function (hz) {
    this.highHz = hz;
    this.updateAxes();
    this.saveSettings();
  };

  Spectrum.prototype.setAveraging = function (num) {
    if (num >= 0) {
      this.averaging = num;
      this.alpha = 2 / (this.averaging + 1);
    }
    this.saveSettings();
  };

  Spectrum.prototype.setDecay = function (num) {
    this.decay = num;
    this.saveSettings();
  };

  Spectrum.prototype.incrementAveraging = function () {
    this.setAveraging(this.averaging + 1);
    this.saveSettings();
  };

  Spectrum.prototype.decrementAveraging = function () {
    if (this.averaging > 0) {
      this.setAveraging(this.averaging - 1);
    }
    this.saveSettings();
  };

  Spectrum.prototype.togglePaused = function () {
    this.paused = !this.paused;
    document().getElementById("pause").textContent = this.paused ? "Run" : "Pause";
    this.saveSettings();
  };

  Spectrum.prototype.setMaxHold = function (maxhold) {
    this.maxHold = maxhold;
    this.binsMax = undefined;
    this.binsMin = undefined;
    this.saveSettings();
  };

  Spectrum.prototype.toggleMaxHold = function () {
    this.setMaxHold(!this.maxHold);
    document().getElementById("max_hold").textContent = this.maxHold ? "Norm" : "Max hold";
    this.saveSettings();
  };

  Spectrum.prototype.saveSettings = function () {
    if (typeof this.radio_pointer !== "undefined") {
      this.radio_pointer.saveSettings();
    }
  };

  Spectrum.prototype.toggleFullscreen = function () {
    const doc = document();
    if (!this.fullscreen) {
      if (this.canvas.requestFullscreen) {
        this.canvas.requestFullscreen();
      } else if (this.canvas.mozRequestFullScreen) {
        this.canvas.mozRequestFullScreen();
      } else if (this.canvas.webkitRequestFullscreen) {
        this.canvas.webkitRequestFullscreen();
      } else if (this.canvas.msRequestFullscreen) {
        this.canvas.msRequestFullscreen();
      }
      this.fullscreen = true;
    } else {
      if (doc.exitFullscreen) {
        doc.exitFullscreen();
      } else if (doc.mozCancelFullScreen) {
        doc.mozCancelFullScreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (doc.msExitFullscreen) {
        doc.msExitFullscreen();
      }
      this.fullscreen = false;
    }
  };

  Spectrum.prototype.forceAutoscale = function () {
    this.autoscale = true;
  };

  Spectrum.prototype.onKeypress = function (e) {
    if (e.key == " ") {
      this.togglePaused();
    } else if (e.key == "f") {
      this.toggleFullscreen();
    } else if (e.key == "c") {
      this.toggleColor();
    } else if (e.key == "ArrowUp") {
      this.positionUp();
    } else if (e.key == "ArrowDown") {
      this.positionDown();
    } else if (e.key == "ArrowLeft") {
      this.rangeDecrease();
    } else if (e.key == "ArrowRight") {
      this.rangeIncrease();
    } else if (e.key == "s") {
      this.incrementSpectrumPercent();
    } else if (e.key == "w") {
      this.decrementSpectrumPercent();
    } else if (e.key == "+") {
      this.incrementAveraging();
    } else if (e.key == "-") {
      this.decrementAveraging();
    } else if (e.key == "m") {
      this.toggleMaxHold();
    }
  };

  Spectrum.prototype.pixel_to_bin = function (pixel) {
    return core().pixelToBin(pixel, this.canvas.width, this.bins);
  };

  Spectrum.prototype.bin_to_hz = function (bin) {
    return core().binToHz(bin, this.centerHz, this.spanHz, this.bins);
  };

  Spectrum.prototype.hz_to_bin = function (hz) {
    return core().hzToBin(hz, this.centerHz, this.spanHz, this.bins);
  };

  Spectrum.prototype.cursorCheck = function () {
    this.cursor_active = document().getElementById("cursor").checked;
  };

  Spectrum.prototype.limitCursor = function (freq) {
    return core().limitCursor(freq, this.centerHz, this.spanHz);
  };

  Spectrum.prototype.cursorUpdate = function (_freq) {
    return;
  };

  Spectrum.prototype.cursorUp = function () {
    this.cursor_freq = this.limitCursor(
      this.cursor_freq + parseInt(document().getElementById("step").value),
    );
    this.cursorUpdate(this.cursor_freq);
  };

  Spectrum.prototype.cursorDown = function () {
    this.cursor_freq = this.limitCursor(
      this.cursor_freq - parseInt(document().getElementById("step").value),
    );
    this.cursorUpdate(this.cursor_freq);
  };

  function Spectrum(id, options) {
    core(); // fail fast if the wasm core isn't ready
    const doc = document();

    // Handle options
    this.centerHz = (options && options.centerHz) ? options.centerHz : 0;
    this.spanHz = (options && options.spanHz) ? options.spanHz : 0;
    this.wf_size = (options && options.wf_size) ? options.wf_size : 0;
    this.wf_rows = (options && options.wf_rows) ? options.wf_rows : 256;
    this.spectrumPercent = (options && options.spectrumPercent) ? options.spectrumPercent : 50;
    this.spectrumPercentStep = (options && options.spectrumPercentStep)
      ? options.spectrumPercentStep
      : 5;
    this.averaging = (options && options.averaging) ? options.averaging : 0;
    this.maxHold = (options && options.maxHold) ? options.maxHold : false;
    this.bins = (options && options.bins) ? options.bins : false;

    // Setup state
    this.paused = false;
    this.fullscreen = false;
    this.min_db = -120;
    this.max_db = 0;
    this.wf_min_db = -120;
    this.wf_max_db = 0;
    this.spectrumHeight = 0;

    // Colors
    this.colorindex = 0;
    this.colormap = colormaps()[0];

    // Create main canvas and adjust dimensions to match actual
    this.canvas = doc.getElementById(id);
    this.canvas.height = this.canvas.clientHeight;
    this.canvas.width = this.canvas.clientWidth;
    this.ctx = this.canvas.getContext("2d");
    this.ctx.fillStyle = "black";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Create offscreen canvas for axes
    this.axes = doc.createElement("canvas");
    this.axes.height = 1; // Updated later
    this.axes.width = this.canvas.width;
    this.ctx_axes = this.axes.getContext("2d");

    // Create offscreen canvas for waterfall
    this.wf = doc.createElement("canvas");
    this.wf.height = this.wf_rows;
    this.wf.width = this.wf_size;
    this.ctx_wf = this.wf.getContext("2d");

    this.autoscale = false;
    this.decay = 1.0;
    this.cursor_active = false;
    this.cursor_step = 1000;
    this.cursor_freq = 10000000;

    this.radio_pointer = undefined;

    // Trigger first render
    this.setAveraging(this.averaging);
    this.updateSpectrumRatio();
    this.resize();
  }

  return Spectrum;
}
