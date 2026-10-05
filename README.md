# Stereogram Analyzer

Recover the hidden 3D structure encoded inside single-image **autostereograms**
(the "Magic Eye" style images).

Given a single autostereogram, the tool estimates the repeating pattern period,
reconstructs the base texture tile, recovers a disparity-based depth map, and
renders the hidden surface in 3D. Results can be exported as images or as a
Wavefront `.obj` point cloud.

There are two ways to run it:

- **🌐 Live web app** — runs entirely in your browser, no install. Includes a
  built-in random-dot stereogram generator so you can try it instantly.
  **→ https://0cool-design.github.io/stereogram-analyzer/**
- **🖥️ Desktop app** — the original PyQt5 application (see below).

---

## 🌐 Live web version

The web app lives in [`docs/`](docs/) and is published with GitHub Pages. It is
a faithful JavaScript port of the Python pipeline and runs 100% client-side —
images never leave your machine. Analysis runs in a Web Worker so the UI stays
responsive, and the 3D surface is rendered with [three.js](https://threejs.org/).

Open the live link above, or serve `docs/` locally:

```bash
cd docs
python -m http.server 8000
# then open http://localhost:8000
```

**Usage:** generate a sample (or drop in your own stereogram) → tweak
parameters → **Analyze** → inspect the base texture, depth map, and interactive
3D surface → export PNGs or an `.obj` point cloud.

---

## 🖥️ Desktop version (Python / PyQt5)

### Requirements

- Python 3.10+
- See [`requirements.txt`](requirements.txt): numpy, Pillow, PyQt5, matplotlib

### Installation

```bash
# (Recommended) create a virtual environment
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

### Usage

```bash
python main.py
```

1. Click **Load Stereogram** and select an autostereogram image
   (`.png`, `.jpg`, `.jpeg`, `.bmp`).
2. Click **Analyze** to estimate the period, recover the texture, and build the
   depth map.
3. Inspect the original image, recovered texture, depth map, and the 3D surface.
4. Use **Save Base Texture**, **Save Depth Map**, or **Export 3D OBJ**.

---

## How it works

Autostereograms encode depth by horizontally shifting a repeating pattern:
regions that appear closer are shifted more than the background period. The
analysis pipeline reverses this:

1. **Period estimation** — finds the dominant horizontal repetition using
   normalized autocorrelation.
2. **Base texture recovery** — averages the tile across all repetitions to
   recover the underlying pattern.
3. **Depth map estimation** — windowed block matching around the base period
   recovers per-pixel disparity, then normalizes it to `[0, 1]` depth.
4. **3D reconstruction** — lifts the depth map into a 3D surface / point cloud
   for visualization and export.

The same four steps are implemented in both versions:

| Step | Python (`stereogram_analyzer/processing.py`) | Web (`docs/assets/stereogram.js`) |
|------|----------------------------------------------|-----------------------------------|
| Period | `estimate_period` | `estimatePeriod` |
| Texture | `recover_base_texture` | `recoverBaseTexture` |
| Depth | `estimate_depth_map` | `estimateDepthMap` |
| Export | `save_point_cloud_obj` | `depthToObj` |

## Project structure

```
stereogram-analyzer/
├── docs/                         # Live web app (GitHub Pages)
│   ├── index.html
│   └── assets/
│       ├── app.js                # UI, rendering, three.js, exports
│       ├── worker.js             # Runs analysis off the main thread
│       ├── stereogram.js         # Core algorithms (JS port) + SIRDS sample
│       └── style.css
├── main.py                       # Desktop entry point
├── requirements.txt
└── stereogram_analyzer/          # Desktop core (NumPy / Pillow / PyQt5)
    ├── __init__.py
    ├── processing.py
    └── gui.py
```

## License

[MIT](LICENSE)
