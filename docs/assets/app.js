/*
 * app.js — UI wiring for the Stereogram Analyzer web app.
 * Handles input, parameter controls, running the worker, rendering the four
 * views (original / texture / depth / 3D surface) and exports.
 */
/* global THREE, Stereogram */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  // ---- state ----
  var currentImage = null; // { width, height, data } downscaled for analysis
  var result = null;        // worker output
  var worker = null;
  var three = null;         // { renderer, scene, camera, controls, mesh, raf }

  // ---- elements ----
  var dropzone = $("dropzone");
  var fileInput = $("file");
  var analyzeBtn = $("analyze");
  var progress = $("progress");
  var progressBar = $("progressBar");
  var progressLabel = $("progressLabel");
  var placeholder = $("placeholder");

  // ---- parameter bindings (slider -> live label) ----
  [
    ["minPeriod", "minPeriodVal"],
    ["maxShift", "maxShiftVal"],
    ["window", "windowVal"],
    ["exagg", "exaggVal"],
  ].forEach(function (pair) {
    var input = $(pair[0]), label = $(pair[1]);
    input.addEventListener("input", function () { label.textContent = input.value; });
  });

  function options() {
    return {
      minPeriod: parseInt($("minPeriod").value, 10),
      maxExtraShift: parseInt($("maxShift").value, 10),
      windowRadius: parseInt($("window").value, 10),
    };
  }

  // ---- input handling ----
  dropzone.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
  });
  ["dragover", "dragenter"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  function loadFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      setImageFromSource(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
    };
    img.onerror = function () { alert("Could not load that image."); };
    img.src = url;
  }

  // Downscale a drawable source to the chosen analysis width, store ImageData.
  function setImageFromSource(source, srcW, srcH) {
    var targetW = parseInt($("analysisWidth").value, 10);
    var scale = Math.min(1, targetW / srcW);
    var w = Math.max(1, Math.round(srcW * scale));
    var h = Math.max(1, Math.round(srcH * scale));
    var cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext("2d");
    ctx.drawImage(source, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h);
    currentImage = { width: w, height: h, data: data.data };
    drawToCanvas("canvasOriginal", currentImage);
    if (placeholder) placeholder.style.display = "none";
    result = null;
    setExportsEnabled(false);
    analyzeBtn.disabled = false;
    $("outPeriod").textContent = "—";
    $("outRes").textContent = w + "×" + h;
    showView("original");
  }

  // ---- sample generator ----
  $("sample").addEventListener("click", function () {
    var w = parseInt($("analysisWidth").value, 10);
    var h = Math.round(w * 0.72);
    var sample = Stereogram.makeSampleStereogram(w, h);
    currentImage = sample;
    drawToCanvas("canvasOriginal", sample);
    if (placeholder) placeholder.style.display = "none";
    result = null;
    setExportsEnabled(false);
    analyzeBtn.disabled = false;
    $("outPeriod").textContent = "—";
    $("outRes").textContent = w + "×" + h;
    showView("original");
  });

  // ---- analysis ----
  analyzeBtn.addEventListener("click", function () {
    if (!currentImage) return;
    runAnalysis();
  });

  function runAnalysis() {
    analyzeBtn.disabled = true;
    setExportsEnabled(false);
    progress.hidden = false;
    setProgress(0, "initialising…");

    if (worker) worker.terminate();
    worker = new Worker("assets/worker.js");

    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === "progress") {
        setProgress(m.value, stageLabel(m.stage));
      } else if (m.type === "done") {
        onResult(m);
      } else if (m.type === "error") {
        progress.hidden = true;
        analyzeBtn.disabled = false;
        alert("Analysis failed: " + m.message);
      }
    };
    worker.onerror = function (err) {
      progress.hidden = true;
      analyzeBtn.disabled = false;
      alert("Worker error: " + err.message);
    };

    // Send a copy so currentImage stays intact (buffer is transferred).
    var copy = currentImage.data.slice();
    worker.postMessage(
      {
        type: "analyze",
        image: { width: currentImage.width, height: currentImage.height, data: copy },
        options: options(),
      },
      [copy.buffer]
    );
  }

  function stageLabel(stage) {
    switch (stage) {
      case "grayscale": return "converting to luminance…";
      case "period": return "estimating pattern period…";
      case "texture": return "recovering base texture…";
      case "depth": return "block-matching disparities…";
      default: return "working…";
    }
  }

  function setProgress(value, label) {
    progressBar.style.width = Math.round(value * 100) + "%";
    progressLabel.textContent = label;
  }

  function onResult(m) {
    result = m;
    progress.hidden = true;
    analyzeBtn.disabled = false;

    $("outPeriod").textContent = m.period + " px";
    $("outRes").textContent = m.width + "×" + m.height;

    drawToCanvas("canvasTexture", m.texture);
    drawToCanvas("canvasDepth", m.depthImage);
    buildSurface(m.depth, m.width, m.height);
    setExportsEnabled(true);

    showView("depth");
  }

  // ---- canvas drawing ----
  function drawToCanvas(id, img) {
    var cv = $(id);
    cv.width = img.width;
    cv.height = img.height;
    var ctx = cv.getContext("2d");
    var out = ctx.createImageData(img.width, img.height);
    out.data.set(img.data);
    ctx.putImageData(out, 0, 0);
  }

  // ---- 3D surface (three.js) ----
  function buildSurface(depth, w, h) {
    var host = $("surface");
    if (!three) three = initThree(host);
    if (three.mesh) {
      three.scene.remove(three.mesh);
      three.mesh.geometry.dispose();
      three.mesh.material.dispose();
    }

    // Downsample the grid for interactive performance.
    var maxDim = 180;
    var step = Math.max(1, Math.ceil(Math.max(w, h) / maxDim));
    var gw = Math.floor((w - 1) / step) + 1;
    var gh = Math.floor((h - 1) / step) + 1;
    var exagg = parseInt($("exagg").value, 10);

    var positions = new Float32Array(gw * gh * 3);
    var colors = new Float32Array(gw * gh * 3);
    var vi = 0;
    for (var gy = 0; gy < gh; gy++) {
      for (var gx = 0; gx < gw; gx++) {
        var sx = gx * step, sy = gy * step;
        var d = depth[sy * w + sx];
        positions[vi * 3] = (sx - w / 2) * 0.5;
        positions[vi * 3 + 1] = (h / 2 - sy) * 0.5;
        positions[vi * 3 + 2] = d * exagg;
        var c = Stereogram.depthColor(d);
        colors[vi * 3] = c[0] / 255;
        colors[vi * 3 + 1] = c[1] / 255;
        colors[vi * 3 + 2] = c[2] / 255;
        vi++;
      }
    }

    // Triangle indices over the sampled grid.
    var indices = [];
    for (var y = 0; y < gh - 1; y++) {
      for (var x = 0; x < gw - 1; x++) {
        var a = y * gw + x;
        var b = a + 1;
        var cc = a + gw;
        var dd = cc + 1;
        indices.push(a, cc, b, b, cc, dd);
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.62,
      metalness: 0.12,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    var mesh = new THREE.Mesh(geo, mat);
    three.scene.add(mesh);
    three.mesh = mesh;

    // Frame the mesh.
    var radius = Math.max(w, h) * 0.5;
    three.camera.position.set(0, -radius * 0.9, radius * 1.1);
    three.camera.lookAt(0, 0, 0);
    three.controls.target.set(0, 0, exagg * 0.3);
    three.controls.update();
  }

  function initThree(host) {
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    sizeRenderer(renderer, host);
    host.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(
      45,
      host.clientWidth / Math.max(1, host.clientHeight),
      0.1,
      5000
    );

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    scene.add(new THREE.AmbientLight(0x5566aa, 0.9));
    var key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1, -1, 2);
    scene.add(key);
    var rim = new THREE.DirectionalLight(0x7c5cff, 0.8);
    rim.position.set(-1, 1, 0.5);
    scene.add(rim);

    var ctx = { renderer: renderer, scene: scene, camera: camera, controls: controls, mesh: null };

    function animate() {
      ctx.raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener("resize", function () {
      sizeRenderer(renderer, host);
      camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
      camera.updateProjectionMatrix();
    });

    return ctx;
  }

  function sizeRenderer(renderer, host) {
    renderer.setSize(host.clientWidth, host.clientHeight, false);
  }

  // ---- tabs ----
  var tabs = document.querySelectorAll(".tab");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () { showView(tab.dataset.view); });
  });

  function showView(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.view === name);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.dataset.view === name);
    });
    // The 3D renderer needs a resize once its container becomes visible.
    if (name === "surface" && three) {
      sizeRenderer(three.renderer, $("surface"));
      three.camera.aspect =
        $("surface").clientWidth / Math.max(1, $("surface").clientHeight);
      three.camera.updateProjectionMatrix();
    }
  }

  // ---- exports ----
  function setExportsEnabled(on) {
    ["saveTexture", "saveDepth", "saveObj"].forEach(function (id) {
      $(id).disabled = !on;
    });
  }

  $("saveTexture").addEventListener("click", function () {
    if (result) downloadCanvas(result.texture, "base_texture.png");
  });
  $("saveDepth").addEventListener("click", function () {
    if (result) downloadCanvas(result.depthImage, "depth_map.png");
  });
  $("saveObj").addEventListener("click", function () {
    if (!result) return;
    var exagg = parseInt($("exagg").value, 10);
    var obj = Stereogram.depthToObj(result.depth, result.width, result.height, 1.0, exagg);
    downloadBlob(new Blob([obj], { type: "text/plain" }), "stereogram_reconstruction.obj");
  });

  function downloadCanvas(img, name) {
    var cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    var ctx = cv.getContext("2d");
    var out = ctx.createImageData(img.width, img.height);
    out.data.set(img.data);
    ctx.putImageData(out, 0, 0);
    cv.toBlob(function (blob) { downloadBlob(blob, name); });
  }

  function downloadBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }
})();
