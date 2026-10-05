/*
 * worker.js — runs the (potentially heavy) analysis pipeline off the main
 * thread so the UI stays responsive, reporting progress back as it goes.
 */
/* global importScripts, Stereogram */
importScripts("stereogram.js");

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type !== "analyze") return;

  var img = msg.image; // { width, height, data }
  var opts = msg.options;

  function report(stage, value) {
    self.postMessage({ type: "progress", stage: stage, value: value });
  }

  try {
    report("grayscale", 0);
    var gray = Stereogram.toGrayscale(img);

    report("period", 0.1);
    var period = Stereogram.estimatePeriod(
      gray,
      img.width,
      img.height,
      opts.minPeriod,
      opts.maxPeriod
    );

    report("texture", 0.25);
    var texture = Stereogram.recoverBaseTexture(img, period);

    var result = Stereogram.estimateDepthMap(
      gray,
      img.width,
      img.height,
      period,
      opts.maxExtraShift,
      opts.windowRadius,
      function (y, h) {
        // Depth matching dominates runtime; map it to 0.25 -> 1.0.
        if (y % 8 === 0 || y === h) report("depth", 0.25 + 0.75 * (y / h));
      }
    );

    var depthImage = Stereogram.depthToImage(result.depth, img.width, img.height);

    self.postMessage(
      {
        type: "done",
        period: period,
        texture: texture,
        depthImage: depthImage,
        depth: result.depth,
        width: img.width,
        height: img.height,
      },
      [texture.data.buffer, depthImage.data.buffer, result.depth.buffer]
    );
  } catch (err) {
    self.postMessage({ type: "error", message: String(err && err.message || err) });
  }
};
