/*
 * stereogram.js — core autostereogram analysis, ported from the Python
 * `stereogram_analyzer` package to plain JavaScript so it runs in the browser
 * (both on the main thread and inside a Web Worker via importScripts).
 *
 * All image data is passed as { width, height, data } where `data` is an
 * RGBA Uint8ClampedArray (the native canvas ImageData layout).
 */
(function (root) {
  "use strict";

  var EPSILON = 1e-8;
  var LUMA = [0.2126, 0.7152, 0.0722];

  /** Convert an RGBA image to a Float32 grayscale array in [0, 1]. */
  function toGrayscale(img) {
    var w = img.width, h = img.height, src = img.data;
    var gray = new Float32Array(w * h);
    for (var i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] =
        (LUMA[0] * src[p] + LUMA[1] * src[p + 1] + LUMA[2] * src[p + 2]) / 255;
    }
    return gray;
  }

  /**
   * Estimate the repeating pattern period (pixels) via horizontal
   * autocorrelation. Mirrors processing.estimate_period.
   */
  function estimatePeriod(gray, w, h, minPeriod, maxPeriod) {
    minPeriod = minPeriod || 24;
    if (!maxPeriod) {
      maxPeriod = Math.max(Math.min(Math.floor(w / 2), 512), minPeriod + 1);
    }
    maxPeriod = Math.min(maxPeriod, w - 1);

    // Row-centred copy (subtract per-row mean) to emphasise repetition.
    var centered = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      var base = y * w, sum = 0;
      for (var x = 0; x < w; x++) sum += gray[base + x];
      var mean = sum / w;
      for (var x2 = 0; x2 < w; x2++) centered[base + x2] = gray[base + x2] - mean;
    }

    var bestPeriod = minPeriod;
    var bestScore = -Infinity;
    for (var shift = minPeriod; shift < maxPeriod; shift++) {
      var num = 0, lsq = 0, rsq = 0;
      for (var ry = 0; ry < h; ry++) {
        var rb = ry * w;
        var lim = w - shift;
        for (var rx = 0; rx < lim; rx++) {
          var a = centered[rb + rx];
          var b = centered[rb + rx + shift];
          num += a * b;
          lsq += a * a;
          rsq += b * b;
        }
      }
      var score = num / (Math.sqrt(lsq * rsq) + EPSILON);
      if (score > bestScore) {
        bestScore = score;
        bestPeriod = shift;
      }
    }
    return bestPeriod;
  }

  /**
   * Recover the repeating base texture tile by averaging columns modulo the
   * period. Returns an RGBA image of size (period x height).
   */
  function recoverBaseTexture(img, period) {
    var w = img.width, h = img.height, src = img.data;
    var repeats = Math.floor(w / period);
    if (repeats < 1) repeats = 1;
    var out = new Uint8ClampedArray(period * h * 4);
    for (var y = 0; y < h; y++) {
      for (var p = 0; p < period; p++) {
        var rSum = 0, gSum = 0, bSum = 0, n = 0;
        for (var k = 0; k < repeats; k++) {
          var sx = k * period + p;
          var si = (y * w + sx) * 4;
          rSum += src[si];
          gSum += src[si + 1];
          bSum += src[si + 2];
          n++;
        }
        var di = (y * period + p) * 4;
        out[di] = rSum / n;
        out[di + 1] = gSum / n;
        out[di + 2] = bSum / n;
        out[di + 3] = 255;
      }
    }
    return { width: period, height: h, data: out };
  }

  // Reflect an index into [0, n) using numpy 'reflect' semantics (edge not
  // repeated): e.g. [1,2,3,4,5] padded -> ...3,2,1,2,3,4,5,4,3...
  function reflectIndex(p, n) {
    if (n === 1) return 0;
    var period = 2 * (n - 1);
    var m = ((p % period) + period) % period;
    return m < n ? m : period - m;
  }

  /**
   * Estimate disparity + normalised depth via per-row windowed block matching.
   * Mirrors processing.estimate_depth_map. `onRow(y, h)` is an optional
   * progress callback.
   */
  function estimateDepthMap(gray, w, h, period, maxExtraShift, windowRadius, onRow) {
    maxExtraShift = maxExtraShift == null ? 16 : maxExtraShift;
    windowRadius = windowRadius == null ? 5 : windowRadius;
    var win = windowRadius;
    var span = 2 * win + 1;

    var disparities = new Float32Array(w * h);
    var padded = new Float32Array(w + 2 * win);

    for (var y = 0; y < h; y++) {
      var rb = y * w;
      // Build reflect-padded row.
      for (var i = 0; i < padded.length; i++) {
        padded[i] = gray[rb + reflectIndex(i - win, w)];
      }

      var limit = w - period;
      for (var x = 0; x < limit; x++) {
        var bestShift = period;
        var bestScore = Infinity;
        var refStart = x; // padded[x .. x+span-1] == original [x-win .. x+win]
        for (var delta = -maxExtraShift; delta <= maxExtraShift; delta++) {
          var shift = period + delta;
          if (shift <= 0 || x + shift >= w) continue;
          var matchStart = x + shift;
          var score = 0;
          for (var kk = 0; kk < span; kk++) {
            var diff = padded[refStart + kk] - padded[matchStart + kk];
            score += diff * diff;
          }
          if (score < bestScore) {
            bestScore = score;
            bestShift = shift;
          }
        }
        disparities[rb + x] = bestShift - period;
      }
      // Propagate last computable disparity to trailing pixels.
      if (w > period) {
        var fill = disparities[rb + (w - period - 1)];
        for (var t = w - period; t < w; t++) disparities[rb + t] = fill;
      }
      if (onRow) onRow(y + 1, h);
    }

    var depth = normalizeDepth(disparities);
    return { disparities: disparities, depth: depth };
  }

  /** Normalise disparities to [0, 1]. Mirrors processing.normalize_depth_map. */
  function normalizeDepth(disparities) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < disparities.length; i++) {
      var v = disparities[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    var out = new Float32Array(disparities.length);
    if (Math.abs(max - min) < 1e-9) return out;
    var inv = 1 / (max - min);
    for (var j = 0; j < disparities.length; j++) {
      out[j] = (disparities[j] - min) * inv;
    }
    return out;
  }

  /**
   * Build a Wavefront OBJ point cloud string from the depth map.
   * Mirrors processing.save_point_cloud_obj (scale_xy, scale_z).
   */
  function depthToObj(depth, w, h, scaleXY, scaleZ) {
    scaleXY = scaleXY == null ? 1.0 : scaleXY;
    scaleZ = scaleZ == null ? 50.0 : scaleZ;
    var lines = ["# Autostereogram recovered point cloud"];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var z = depth[y * w + x] * scaleZ;
        lines.push(
          "v " +
            (x * scaleXY).toFixed(6) +
            " " +
            (y * scaleXY).toFixed(6) +
            " " +
            z.toFixed(6)
        );
      }
    }
    return lines.join("\n") + "\n";
  }

  // --- depth colour palette (turquoise -> violet -> magenta) -----------------
  var PALETTE = [
    [0.0, [11, 16, 32]],
    [0.3, [27, 58, 107]],
    [0.55, [42, 163, 176]],
    [0.78, [124, 92, 255]],
    [1.0, [255, 106, 213]],
  ];

  /** Map a depth value t in [0,1] to [r,g,b] (0-255) using PALETTE. */
  function depthColor(t) {
    if (t <= 0) return PALETTE[0][1];
    if (t >= 1) return PALETTE[PALETTE.length - 1][1];
    for (var i = 1; i < PALETTE.length; i++) {
      if (t <= PALETTE[i][0]) {
        var lo = PALETTE[i - 1], hi = PALETTE[i];
        var f = (t - lo[0]) / (hi[0] - lo[0]);
        return [
          lo[1][0] + (hi[1][0] - lo[1][0]) * f,
          lo[1][1] + (hi[1][1] - lo[1][1]) * f,
          lo[1][2] + (hi[1][2] - lo[1][2]) * f,
        ];
      }
    }
    return PALETTE[PALETTE.length - 1][1];
  }

  /** Render a normalised depth map to an RGBA image using the palette. */
  function depthToImage(depth, w, h) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, p = 0; i < depth.length; i++, p += 4) {
      var c = depthColor(depth[i]);
      out[p] = c[0];
      out[p + 1] = c[1];
      out[p + 2] = c[2];
      out[p + 3] = 255;
    }
    return { width: w, height: h, data: out };
  }

  // --- sample generator (SIRDS) ---------------------------------------------
  // Produces a random-dot autostereogram encoding a simple 3D scene so the
  // live demo works with zero setup.
  function sampleDepthAt(x, y, w, h) {
    var nx = x / w, ny = y / h;
    var d = 0;
    // Large dome, slightly left of centre.
    var dome = domeHeight(nx, ny, 0.4, 0.5, 0.26);
    // Smaller dome, lower right.
    var dome2 = domeHeight(nx, ny, 0.68, 0.64, 0.15);
    d = Math.max(dome, dome2);
    return d; // 0 (far) .. 1 (near)
  }

  function domeHeight(nx, ny, cx, cy, r) {
    var dx = nx - cx, dy = ny - cy;
    var dist2 = dx * dx + dy * dy;
    if (dist2 >= r * r) return 0;
    return Math.sqrt(1 - dist2 / (r * r));
  }

  var SAMPLE_COLORS = [
    [11, 16, 32],
    [42, 163, 176],
    [124, 92, 255],
    [255, 106, 213],
    [232, 238, 247],
  ];

  function makeSampleStereogram(w, h) {
    var E = Math.round(w * 0.14); // eye separation (max pattern period)
    var mu = 1 / 3; // depth of field
    var data = new Uint8ClampedArray(w * h * 4);
    var same = new Int32Array(w);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) same[x] = x;
      for (var x3 = 0; x3 < w; x3++) {
        var z = sampleDepthAt(x3, y, w, h);
        var sep = Math.round(((1 - mu * z) * E) / (2 - mu * z));
        var left = x3 - (sep >> 1);
        var right = left + sep;
        if (left >= 0 && right < w) same[right] = left;
      }
      // Resolve colours left-to-right (same[x] < x is guaranteed).
      for (var x4 = 0; x4 < w; x4++) {
        var di = (y * w + x4) * 4;
        var col;
        if (same[x4] === x4) {
          col = SAMPLE_COLORS[(Math.random() * SAMPLE_COLORS.length) | 0];
        } else {
          var si = (y * w + same[x4]) * 4;
          data[di] = data[si];
          data[di + 1] = data[si + 1];
          data[di + 2] = data[si + 2];
          data[di + 3] = 255;
          continue;
        }
        data[di] = col[0];
        data[di + 1] = col[1];
        data[di + 2] = col[2];
        data[di + 3] = 255;
      }
    }
    return { width: w, height: h, data: data };
  }

  var api = {
    toGrayscale: toGrayscale,
    estimatePeriod: estimatePeriod,
    recoverBaseTexture: recoverBaseTexture,
    estimateDepthMap: estimateDepthMap,
    normalizeDepth: normalizeDepth,
    depthToObj: depthToObj,
    depthColor: depthColor,
    depthToImage: depthToImage,
    makeSampleStereogram: makeSampleStereogram,
  };

  root.Stereogram = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
