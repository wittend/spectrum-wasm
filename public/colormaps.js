/*
 * Default colormaps for spectrum.js / spectrum-wasm.
 *
 * Defines the globals the original spectrum.js expects:
 *   colormaps     — array of colormaps, each an array of [r, g, b]
 *   colormapNames — display names, same order
 *
 * Host applications that already ship their own colormaps.js can keep it;
 * this file is only a default. Lengths deliberately differ (the original code
 * comments that real colormap sets are not all the same length).
 */
(function (g) {
  "use strict";

  function ramp(stops, n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      var k = 0;
      while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      var a = stops[k], b = stops[k + 1];
      var u = (t - a[0]) / (b[0] - a[0] || 1);
      out.push([
        Math.round(a[1] + (b[1] - a[1]) * u),
        Math.round(a[2] + (b[2] - a[2]) * u),
        Math.round(a[3] + (b[3] - a[3]) * u),
      ]);
    }
    return out;
  }

  var maps = [
    {
      name: "Turbo",
      n: 256,
      stops: [
        [0.0, 48, 18, 59],
        [0.15, 70, 107, 227],
        [0.3, 40, 188, 235],
        [0.45, 50, 241, 152],
        [0.6, 164, 252, 60],
        [0.75, 251, 185, 56],
        [0.9, 228, 70, 10],
        [1.0, 122, 4, 3],
      ],
    },
    {
      name: "Viridis",
      n: 256,
      stops: [
        [0.0, 68, 1, 84],
        [0.25, 59, 82, 139],
        [0.5, 33, 145, 140],
        [0.75, 94, 201, 98],
        [1.0, 253, 231, 37],
      ],
    },
    {
      name: "Hot",
      n: 192,
      stops: [
        [0.0, 0, 0, 0],
        [0.4, 230, 0, 0],
        [0.8, 255, 210, 0],
        [1.0, 255, 255, 255],
      ],
    },
    {
      name: "Grayscale",
      n: 128,
      stops: [
        [0.0, 0, 0, 0],
        [1.0, 255, 255, 255],
      ],
    },
    {
      name: "Classic",
      n: 64,
      stops: [
        [0.0, 0, 0, 32],
        [0.25, 0, 0, 255],
        [0.5, 0, 255, 255],
        [0.75, 255, 255, 0],
        [1.0, 255, 0, 0],
      ],
    },
  ];

  g.colormaps = maps.map(function (m) {
    return ramp(m.stops, m.n);
  });
  g.colormapNames = maps.map(function (m) {
    return m.name;
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
