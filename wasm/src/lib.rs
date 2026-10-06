//! Numeric kernels for spectrum.js, compiled to WebAssembly.
//!
//! Every function mirrors an expression in the original JavaScript
//! (`.contrib/spectrum.js`) and keeps the same operation order so results are
//! bit-identical to what V8 produces. JavaScript-specific semantics
//! (`Math.round`, `Math.min`/`Math.max` NaN propagation, `Math.max()` of an
//! empty list) are reproduced explicitly rather than using Rust's defaults.
//!
//! The ABI is plain `extern "C"` over linear memory: the JavaScript host
//! allocates buffers with [`alloc`], fills them through typed-array views and
//! passes pointers back in. No wasm-bindgen is needed.

use std::alloc::{alloc as raw_alloc, dealloc as raw_dealloc, Layout};

// ---------------------------------------------------------------------------
// Memory management exported to the host.
// ---------------------------------------------------------------------------

fn layout(bytes: usize) -> Layout {
    // 8-byte alignment so the block can back a Float64Array.
    Layout::from_size_align(bytes.max(8), 8).unwrap()
}

/// Allocate `bytes` bytes, 8-byte aligned. Returns 0 on failure.
#[no_mangle]
pub extern "C" fn alloc(bytes: usize) -> *mut u8 {
    unsafe { raw_alloc(layout(bytes)) }
}

/// Free a block previously returned by [`alloc`] with the same `bytes`.
#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, bytes: usize) {
    if !ptr.is_null() {
        unsafe { raw_dealloc(ptr, layout(bytes)) }
    }
}

// ---------------------------------------------------------------------------
// JavaScript Math semantics.
// ---------------------------------------------------------------------------

#[inline(always)]
fn floor(x: f64) -> f64 {
    x.floor() // f64.floor
}

#[inline(always)]
fn ceil(x: f64) -> f64 {
    x.ceil() // f64.ceil
}

/// `Math.round`: round half toward +Infinity, preserve -0 and NaN.
#[no_mangle]
pub extern "C" fn js_round(x: f64) -> f64 {
    let f = floor(x);
    // x - f is exact for finite x, so this never misrounds 0.49999999999999994.
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    // Math.round keeps the sign of zero for inputs in [-0.5, -0].
    if r == 0.0 && x.is_sign_negative() {
        -0.0
    } else if x.is_infinite() {
        x
    } else {
        r
    }
}

#[no_mangle]
pub extern "C" fn js_floor(x: f64) -> f64 {
    floor(x)
}

#[no_mangle]
pub extern "C" fn js_ceil(x: f64) -> f64 {
    ceil(x)
}

/// `Math.max(a, b)` including NaN propagation and +0 > -0.
#[inline]
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { b } else { a };
    }
    if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)` including NaN propagation and -0 < +0.
#[inline]
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(...arr)`; `-Infinity` for an empty array.
#[no_mangle]
pub unsafe extern "C" fn array_max(ptr: *const f64, n: usize) -> f64 {
    let mut m = f64::NEG_INFINITY;
    for i in 0..n {
        m = js_max(m, *ptr.add(i));
    }
    m
}

/// `Math.min(...arr)`; `Infinity` for an empty array.
#[no_mangle]
pub unsafe extern "C" fn array_min(ptr: *const f64, n: usize) -> f64 {
    let mut m = f64::INFINITY;
    for i in 0..n {
        m = js_min(m, *ptr.add(i));
    }
    m
}

// ---------------------------------------------------------------------------
// Spectrum.prototype kernels.
// ---------------------------------------------------------------------------

/// `Spectrum.prototype.squeeze`.
#[no_mangle]
pub extern "C" fn squeeze(value: f64, out_min: f64, out_max: f64, min_db: f64, max_db: f64) -> f64 {
    if value <= min_db {
        out_min
    } else if value >= max_db {
        out_max
    } else {
        js_round((value - min_db) / (max_db - min_db) * out_max)
    }
}

/// Colormap index for a bin given the precomputed waterfall range
/// `wf_max_db - wf_min_db` (same expression and order as the original).
#[inline(always)]
fn cmap_index(bin: f64, len_m1: f64, last: usize, wf_min_db: f64, range: f64) -> usize {
    let mut scaled = (bin - wf_min_db) / range;
    if scaled > 1.0 {
        scaled = 1.0;
    }
    if scaled < 0.0 {
        scaled = 0.0;
    }
    // x is in [0, len-1] or NaN; Math.round on non-negatives. The round-up
    // is done in integers: the fractional part is effectively random, and
    // V8 lowers float selects to branches that would mispredict.
    let x = len_m1 * scaled;
    let f = floor(x);
    let idx = (f as usize) + ((x - f >= 0.5) as usize);
    if x.is_nan() {
        last // the original's catch block painted the last colour
    } else {
        idx // never exceeds `last` because x <= len-1
    }
}

/// Colormap index for one bin, as computed in `rowToImageData`.
/// Returns `cmap_len - 1` where the original fell into its `catch` block
/// (NaN bins), which is what that block painted.
#[no_mangle]
pub extern "C" fn colormap_index(bin: f64, cmap_len: usize, wf_min_db: f64, wf_max_db: f64) -> usize {
    if cmap_len == 0 {
        return 0;
    }
    cmap_index(bin, (cmap_len as f64) - 1.0, cmap_len - 1, wf_min_db, wf_max_db - wf_min_db)
}

/// `Spectrum.prototype.rowToImageData`: map `n` bins to RGBA pixels.
///
/// `cmap` holds `cmap_len` RGBA entries (4 bytes each, alpha already 255),
/// so each pixel is a single 32-bit copy. `out` receives `4 * n` bytes.
#[no_mangle]
pub unsafe extern "C" fn row_to_rgba(
    bins: *const f64,
    n: usize,
    cmap: *const u32,
    cmap_len: usize,
    wf_min_db: f64,
    wf_max_db: f64,
    out: *mut u32,
) {
    if cmap_len == 0 {
        return;
    }
    let range = wf_max_db - wf_min_db;
    let len_m1 = (cmap_len as f64) - 1.0;
    let last = cmap_len - 1;
    let bins = std::slice::from_raw_parts(bins, n);
    let out = std::slice::from_raw_parts_mut(out, n);
    let cmap = std::slice::from_raw_parts(cmap, cmap_len);
    for (o, &b) in out.iter_mut().zip(bins) {
        *o = *cmap.get_unchecked(cmap_index(b, len_m1, last, wf_min_db, range));
    }
}

/// Exponential FFT averaging: `avg[i] += alpha * (bins[i] - avg[i])`.
#[no_mangle]
pub unsafe extern "C" fn average_update(avg: *mut f64, bins: *const f64, n: usize, alpha: f64) {
    for i in 0..n {
        let a = avg.add(i);
        *a += alpha * (*bins.add(i) - *a);
    }
}

/// Max hold with decay, as in `drawSpectrum`.
#[no_mangle]
pub unsafe extern "C" fn max_hold_update(max: *mut f64, bins: *const f64, n: usize, decay: f64) {
    for i in 0..n {
        let m = max.add(i);
        let b = *bins.add(i);
        if b > *m {
            *m = b;
        } else {
            *m = decay * *m;
        }
    }
}

/// Min hold (no decay), as in `drawSpectrum`.
#[no_mangle]
pub unsafe extern "C" fn min_hold_update(min: *mut f64, bins: *const f64, n: usize) {
    for i in 0..n {
        let m = min.add(i);
        let b = *bins.add(i);
        if b < *m {
            *m = b;
        }
    }
}

/// Screen y for an amplitude, as in `drawFFT` / `drawCursor`.
#[no_mangle]
pub extern "C" fn db_to_y(value: f64, min_db: f64, max_db: f64, spectrum_height: f64) -> f64 {
    let dbm_per_line = spectrum_height / (max_db - min_db);
    let s = (value - min_db) * dbm_per_line;
    spectrum_height - s
}

/// Y coordinate for every bin of the `drawFFT` path.
#[no_mangle]
pub unsafe extern "C" fn fft_path_y(
    bins: *const f64,
    n: usize,
    min_db: f64,
    max_db: f64,
    spectrum_height: f64,
    out: *mut f64,
) {
    let dbm_per_line = spectrum_height / (max_db - min_db);
    for i in 0..n {
        let s = (*bins.add(i) - min_db) * dbm_per_line;
        *out.add(i) = spectrum_height - s;
    }
}

/// Frequency-axis tick increment from `updateAxes`.
#[no_mangle]
pub extern "C" fn axis_increment(span_hz: f64, nbins: f64) -> f64 {
    let ratio = span_hz / nbins;
    let inc = if ratio == 40.0 {
        5000.0
    } else if ratio == 80.0 {
        10000.0
    } else if ratio == 200.0 || ratio == 400.0 {
        50000.0
    } else if ratio == 800.0 {
        100000.0
    } else if ratio == 1000.0 {
        200000.0
    } else if ratio == 2000.0 {
        500000.0
    } else if ratio == 4000.0 || ratio == 8000.0 {
        1000000.0
    } else if ratio == 16000.0 || ratio == 20000.0 {
        2000000.0
    } else {
        ratio * 100.0
    };
    if inc.is_nan() {
        2000000.0
    } else {
        inc
    }
}

/// First frequency tick: `start_freq - (start_freq % inc)`.
#[no_mangle]
pub extern "C" fn axis_first_tick(start_freq: f64, inc: f64) -> f64 {
    start_freq - (start_freq % inc)
}

/// Autoscale bound: `increment * Math.floor(v / increment)`.
#[no_mangle]
pub extern "C" fn autoscale_floor(v: f64, increment: f64) -> f64 {
    increment * floor(v / increment)
}

/// Autoscale bound: `increment * Math.ceil(v / increment)`.
#[no_mangle]
pub extern "C" fn autoscale_ceil(v: f64, increment: f64) -> f64 {
    increment * ceil(v / increment)
}

/// `Spectrum.prototype.pixel_to_bin`.
#[no_mangle]
pub extern "C" fn pixel_to_bin(pixel: f64, canvas_width: f64, bins: f64) -> f64 {
    floor((pixel / canvas_width) * bins)
}

/// `Spectrum.prototype.bin_to_hz`.
#[no_mangle]
pub extern "C" fn bin_to_hz(bin: f64, center_hz: f64, span_hz: f64, bins: f64) -> f64 {
    let start_freq = center_hz - (span_hz / 2.0);
    start_freq + ((span_hz / bins) * bin)
}

/// `Spectrum.prototype.hz_to_bin`.
#[no_mangle]
pub extern "C" fn hz_to_bin(hz: f64, center_hz: f64, span_hz: f64, bins: f64) -> f64 {
    let start_freq = center_hz - (span_hz / 2.0);
    floor(((hz - start_freq) / span_hz) * bins)
}

/// `Spectrum.prototype.limitCursor`.
#[no_mangle]
pub extern "C" fn limit_cursor(freq: f64, center_hz: f64, span_hz: f64) -> f64 {
    let start_freq = center_hz - (span_hz / 2.0);
    let end_freq = center_hz + (span_hz / 2.0);
    js_min(js_max(start_freq, freq), end_freq)
}

/// Filter rectangle `[x, width]` from `drawFilter`, written to `out`.
#[no_mangle]
pub unsafe extern "C" fn filter_rect(
    frequency: f64,
    start_freq: f64,
    filter_low: f64,
    filter_high: f64,
    hz_per_pixel: f64,
    out: *mut f64,
) {
    let x = ((frequency - start_freq) + filter_low) / hz_per_pixel;
    let x1 = ((frequency - start_freq) + filter_high) / hz_per_pixel;
    *out = x;
    *out.add(1) = x1 - x;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_js() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert!(js_round(-0.2).is_sign_negative());
    }

    #[test]
    fn floor_matches_std() {
        for &x in &[-3.5, -3.0, -0.1, 0.1, 2.9, 1e20, -1e20] {
            assert_eq!(floor(x), x.floor(), "{x}");
        }
    }
}
