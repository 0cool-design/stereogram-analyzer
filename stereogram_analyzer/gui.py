"""
PyQt5 user interface for the stereogram analysis toolkit.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
from matplotlib import cm
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure
from PyQt5 import QtCore, QtGui, QtWidgets

from .processing import (
    AnalysisResult,
    estimate_depth_map,
    estimate_period,
    load_image,
    recover_base_texture,
    save_point_cloud_obj,
)


def _array_to_qimage(array: np.ndarray) -> QtGui.QImage:
    """
    Convert a float32 numpy array in [0, 1] to a QImage for display.

    Supports grayscale (H, W) and RGB (H, W, 3) inputs.
    """
    if array.ndim == 2:
        array = np.stack((array,) * 3, axis=-1)
    array_uint8 = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    height, width, channels = array_uint8.shape
    bytes_per_line = channels * width
    image = QtGui.QImage(
        array_uint8.data,
        width,
        height,
        bytes_per_line,
        QtGui.QImage.Format_RGB888,
    )
    # Keep a reference to avoid garbage collection.
    image.ndarray = array_uint8
    return image


class ImageViewer(QtWidgets.QLabel):
    """
    QLabel subclass that maintains aspect ratio scaling.
    """

    def __init__(self, title: str, parent: Optional[QtWidgets.QWidget] = None) -> None:
        super().__init__(parent)
        self.setFrameShape(QtWidgets.QFrame.Panel)
        self.setFrameShadow(QtWidgets.QFrame.Sunken)
        self.setAlignment(QtCore.Qt.AlignCenter)
        self.setMinimumSize(200, 200)
        self.title = title
        self.setText(f"{title}\n(No image)")

    def set_array(self, array: np.ndarray) -> None:
        qimage = _array_to_qimage(array)
        pixmap = QtGui.QPixmap.fromImage(qimage)
        self.setPixmap(pixmap.scaled(self.size(), QtCore.Qt.KeepAspectRatio, QtCore.Qt.SmoothTransformation))

    def resizeEvent(self, event: QtGui.QResizeEvent) -> None:  # noqa: D401
        super().resizeEvent(event)
        pixmap = self.pixmap()
        if pixmap:
            self.setPixmap(
                pixmap.scaled(
                    self.size(),
                    QtCore.Qt.KeepAspectRatio,
                    QtCore.Qt.SmoothTransformation,
                )
            )


class SurfaceCanvas(FigureCanvasQTAgg):
    """
    Matplotlib canvas embedded in Qt for displaying 3D surfaces.
    """

    def __init__(self, parent: Optional[QtWidgets.QWidget] = None) -> None:
        self.figure = Figure(figsize=(5, 4))
        super().__init__(self.figure)
        self.setParent(parent)
        self.axes = self.figure.add_subplot(111, projection="3d")
        self.axes.set_title("Recovered 3D Surface")
        self.axes.set_xlabel("X")
        self.axes.set_ylabel("Y")
        self.axes.set_zlabel("Depth")

    def update_surface(self, depth_map: np.ndarray) -> None:
        self.figure.clf()
        axes = self.figure.add_subplot(111, projection="3d")

        height, width = depth_map.shape
        # Downsample large maps for rendering performance.
        step = max(1, max(height, width) // 200)
        sampled = depth_map[::step, ::step]
        y = np.arange(sampled.shape[0])
        x = np.arange(sampled.shape[1])
        xs, ys = np.meshgrid(x, y)
        axes.plot_surface(xs, ys, sampled, cmap="viridis", linewidth=0, antialiased=True)
        axes.set_title("Recovered 3D Surface")
        axes.set_xlabel("X")
        axes.set_ylabel("Y")
        axes.set_zlabel("Depth")
        axes.view_init(elev=60, azim=-60)
        self.draw_idle()


class MainWindow(QtWidgets.QMainWindow):
    """
    Top-level window providing stereogram analysis controls and visualizations.
    """

    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Stereogram Analyzer")
        self.resize(1280, 720)

        self._image_path: Optional[Path] = None
        self._image_array: Optional[np.ndarray] = None
        self._analysis_result: Optional[AnalysisResult] = None

        self._build_ui()

    # ----- UI setup -----------------------------------------------------

    def _build_ui(self) -> None:
        central = QtWidgets.QWidget(self)
        self.setCentralWidget(central)

        main_layout = QtWidgets.QVBoxLayout(central)

        controls_layout = QtWidgets.QHBoxLayout()
        self.load_button = QtWidgets.QPushButton("Load Stereogram")
        self.analyze_button = QtWidgets.QPushButton("Analyze")
        self.analyze_button.setEnabled(False)

        self.save_texture_button = QtWidgets.QPushButton("Save Base Texture")
        self.save_texture_button.setEnabled(False)
        self.save_depth_button = QtWidgets.QPushButton("Save Depth Map")
        self.save_depth_button.setEnabled(False)
        self.save_obj_button = QtWidgets.QPushButton("Export 3D OBJ")
        self.save_obj_button.setEnabled(False)

        controls_layout.addWidget(self.load_button)
        controls_layout.addWidget(self.analyze_button)
        controls_layout.addStretch()
        controls_layout.addWidget(self.save_texture_button)
        controls_layout.addWidget(self.save_depth_button)
        controls_layout.addWidget(self.save_obj_button)

        main_layout.addLayout(controls_layout)

        viewers_layout = QtWidgets.QHBoxLayout()
        self.original_view = ImageViewer("Original Stereogram")
        self.texture_view = ImageViewer("Recovered Texture")
        self.depth_view = ImageViewer("Depth Map")

        viewers_layout.addWidget(self.original_view, stretch=1)
        viewers_layout.addWidget(self.texture_view, stretch=1)
        viewers_layout.addWidget(self.depth_view, stretch=1)

        main_layout.addLayout(viewers_layout, stretch=2)

        self.surface_canvas = SurfaceCanvas(self)
        main_layout.addWidget(self.surface_canvas, stretch=3)

        # Status bar information line.
        self.status_label = QtWidgets.QLabel("Load a stereogram image to begin.")
        main_layout.addWidget(self.status_label)

        # Connect signals.
        self.load_button.clicked.connect(self._on_load_clicked)
        self.analyze_button.clicked.connect(self._on_analyze_clicked)
        self.save_texture_button.clicked.connect(self._on_save_texture_clicked)
        self.save_depth_button.clicked.connect(self._on_save_depth_clicked)
        self.save_obj_button.clicked.connect(self._on_save_obj_clicked)

    # ----- Event handlers ----------------------------------------------

    def _on_load_clicked(self) -> None:
        dialog = QtWidgets.QFileDialog(self, "Select stereogram image")
        dialog.setNameFilters(["Images (*.png *.jpg *.jpeg *.bmp)", "All files (*)"])
        if dialog.exec_():
            selected = dialog.selectedFiles()[0]
            self._load_image(Path(selected))

    def _load_image(self, path: Path) -> None:
        try:
            self._image_array = load_image(str(path))
        except Exception as exc:  # noqa: BLE001
            QtWidgets.QMessageBox.critical(self, "Error Loading Image", str(exc))
            return

        self._image_path = path
        self._analysis_result = None
        self.original_view.set_array(self._image_array)
        self.texture_view.setText("Recovered Texture\n(Not available)")
        self.depth_view.setText("Depth Map\n(Not available)")
        self.surface_canvas.figure.clf()
        self.surface_canvas.draw_idle()

        self.analyze_button.setEnabled(True)
        self.save_texture_button.setEnabled(False)
        self.save_depth_button.setEnabled(False)
        self.save_obj_button.setEnabled(False)
        self.status_label.setText(f"Loaded image: {path.name}. Click Analyze to continue.")

    def _on_analyze_clicked(self) -> None:
        if self._image_array is None:
            QtWidgets.QMessageBox.warning(self, "No Image", "Please load a stereogram image first.")
            return

        self.status_label.setText("Analyzing stereogram... Please wait.")
        QtWidgets.QApplication.setOverrideCursor(QtCore.Qt.WaitCursor)
        try:
            period = estimate_period(self._image_array)
            base_texture = recover_base_texture(self._image_array, period)
            disparities, depth_map = estimate_depth_map(self._image_array, period)
            self._analysis_result = AnalysisResult(
                period=period,
                base_texture=base_texture,
                depth_map=depth_map,
                disparities=disparities,
            )
        except Exception as exc:  # noqa: BLE001
            QtWidgets.QApplication.restoreOverrideCursor()
            QtWidgets.QMessageBox.critical(self, "Analysis Failed", str(exc))
            self.status_label.setText("Analysis failed.")
            return
        finally:
            QtWidgets.QApplication.restoreOverrideCursor()

        assert self._analysis_result is not None

        self.texture_view.set_array(self._analysis_result.base_texture)
        depth_colored = cm.get_cmap("viridis")(self._analysis_result.depth_map)[..., :3]
        self.depth_view.set_array(depth_colored.astype(np.float32))
        self.surface_canvas.update_surface(self._analysis_result.depth_map)

        self.save_texture_button.setEnabled(True)
        self.save_depth_button.setEnabled(True)
        self.save_obj_button.setEnabled(True)
        self.status_label.setText(
            f"Analysis complete. Estimated period: {self._analysis_result.period} px."
        )

    def _on_save_texture_clicked(self) -> None:
        if self._analysis_result is None:
            return
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save Base Texture",
            "base_texture.png",
            "PNG Images (*.png)",
        )
        if path:
            qimage = _array_to_qimage(self._analysis_result.base_texture)
            qimage.save(path)
            self.status_label.setText(f"Saved base texture to {Path(path).name}.")

    def _on_save_depth_clicked(self) -> None:
        if self._analysis_result is None:
            return
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Save Depth Map",
            "depth_map.png",
            "PNG Images (*.png)",
        )
        if path:
            qimage = _array_to_qimage(self._analysis_result.depth_map)
            qimage.save(path)
            self.status_label.setText(f"Saved depth map to {Path(path).name}.")

    def _on_save_obj_clicked(self) -> None:
        if self._analysis_result is None:
            return
        path, _ = QtWidgets.QFileDialog.getSaveFileName(
            self,
            "Export OBJ",
            "stereogram_reconstruction.obj",
            "Wavefront OBJ (*.obj)",
        )
        if path:
            save_point_cloud_obj(path, self._analysis_result.depth_map)
            self.status_label.setText(f"Exported OBJ to {Path(path).name}.")


__all__ = ["MainWindow"]

