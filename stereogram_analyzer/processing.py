"""
Core processing utilities for analyzing single-image autostereograms.

The goal is to:
- Estimate the base repeating pattern period.
- Recover the base texture tile.
- Estimate a depth map by recovering disparities relative to the period.
- Generate 3D point clouds and export them for visualization.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

import numpy as np
from PIL import Image

# Numerical stability constant used in correlation calculations.
EPSILON = 1e-8


@dataclass
class AnalysisResult:
    """
    Container for outputs of the stereogram analysis pipeline.

    Attributes
    ----------
    period:
        Estimated repeating pattern width in pixels.
    base_texture:
        Recovered repeating tile as an array of shape (H, period, 3).
    depth_map:
        Estimated depth map as a float32 array with values in [0, 1].
    disparities:
        Raw disparity values (in pixels) prior to normalization, matching depth_map size.
    """

    period: int
    base_texture: np.ndarray
    depth_map: np.ndarray
    disparities: np.ndarray


def load_image(path: str) -> np.ndarray:
    """
    Load an image from disk and return an RGB float32 numpy array in [0, 1].

    Parameters
    ----------
    path:
        Path to the stereogram image file.

    Returns
    -------
    np.ndarray
        Array of shape (H, W, 3) in float32.
    """
    image = Image.open(path).convert("RGB")
    array = np.asarray(image, dtype=np.float32) / 255.0
    return array


def _to_grayscale(rgb: np.ndarray) -> np.ndarray:
    """
    Convert an RGB image to grayscale using luminance coefficients.

    Returns
    -------
    np.ndarray
        Grayscale array in float32 with values in [0, 1].
    """
    return np.dot(rgb[..., :3], np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))


def estimate_period(
    image: np.ndarray,
    min_period: int = 24,
    max_period: int | None = None,
) -> int:
    """
    Estimate the repeating pattern period in pixels using horizontal autocorrelation.

    Parameters
    ----------
    image:
        RGB stereogram image as float32 array.
    min_period:
        Minimum acceptable period (to avoid spurious tiny matches).
    max_period:
        Optional maximum acceptable period. Defaults to image width // 2.

    Returns
    -------
    int
        Detected period in pixels.
    """
    grayscale = _to_grayscale(image)
    height, width = grayscale.shape
    if max_period is None:
        max_period = max(min(width // 2, 512), min_period + 1)
    max_period = min(max_period, width - 1)

    # Normalize each row to zero mean to emphasize repeating patterns.
    row_centered = grayscale - grayscale.mean(axis=1, keepdims=True)

    best_period = min_period
    best_score = -np.inf

    # Compute correlation scores for shifts in range.
    for shift in range(min_period, max_period):
        left = row_centered[:, :-shift]
        right = row_centered[:, shift:]
        numerator = np.sum(left * right)
        denominator = np.sqrt(np.sum(left**2) * np.sum(right**2)) + EPSILON
        score = numerator / denominator
        if score > best_score:
            best_score = score
            best_period = shift

    return best_period


def recover_base_texture(image: np.ndarray, period: int) -> np.ndarray:
    """
    Recover the repeating base texture tile by averaging columns modulo period.

    Parameters
    ----------
    image:
        RGB stereogram image.
    period:
        Estimated period width.

    Returns
    -------
    np.ndarray
        Base texture tile of shape (H, period, 3).
    """
    height, width, channels = image.shape
    repeats = width // period
    trimmed_width = repeats * period
    trimmed = image[:, :trimmed_width, :]

    # Reshape to (H, repeats, period, C) and average over repeats.
    tile = trimmed.reshape(height, repeats, period, channels).mean(axis=1)
    return tile


def _compute_row_disparities(
    row: np.ndarray,
    period: int,
    max_extra_shift: int,
    window_radius: int,
) -> np.ndarray:
    """
    Estimate disparities for a single row using windowed block matching.

    Parameters
    ----------
    row:
        1D grayscale array for a single scanline.
    period:
        Base repeating period.
    max_extra_shift:
        Maximum deviation (+/-) from the base period to consider.
    window_radius:
        Radius of the comparison window.

    Returns
    -------
    np.ndarray
        Disparity per column for the given row.
    """
    width = row.shape[0]
    disparities = np.zeros(width, dtype=np.float32)
    window = window_radius
    padded = np.pad(row, pad_width=window, mode="reflect")

    for x in range(width - period):
        ref_start = x
        best_shift = period
        best_score = np.inf

        ref_slice = padded[ref_start : ref_start + 2 * window + 1]

        for delta in range(-max_extra_shift, max_extra_shift + 1):
            shift = period + delta
            if shift <= 0 or x + shift >= width:
                continue
            match_start = x + shift
            match_slice = padded[match_start : match_start + 2 * window + 1]
            diff = ref_slice - match_slice
            score = np.sum(diff * diff)
            if score < best_score:
                best_score = score
                best_shift = shift

        disparities[x] = best_shift - period

    # Propagate the last computable disparity to trailing pixels to avoid zeros.
    if width > period:
        disparities[width - period :] = disparities[width - period - 1]
    return disparities


def estimate_depth_map(
    image: np.ndarray,
    period: int,
    max_extra_shift: int = 16,
    window_radius: int = 5,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Estimate disparity and depth map for the stereogram.

    Parameters
    ----------
    image:
        RGB stereogram image.
    period:
        Previously detected repeating period.
    max_extra_shift:
        Maximum deviation from the period to consider for block matching.
    window_radius:
        Half-width of the block matching window.

    Returns
    -------
    tuple(np.ndarray, np.ndarray)
        - disparities: float32 array matching image size describing pixel shifts.
        - depth_map: normalized float32 array in [0, 1].
    """
    grayscale = _to_grayscale(image)
    height, width = grayscale.shape

    disparities = np.zeros_like(grayscale, dtype=np.float32)
    for y in range(height):
        disparities[y] = _compute_row_disparities(
            grayscale[y], period, max_extra_shift=max_extra_shift, window_radius=window_radius
        )

    depth_map = normalize_depth_map(disparities)
    return disparities, depth_map


def normalize_depth_map(disparities: np.ndarray) -> np.ndarray:
    """
    Normalize disparity values to the [0, 1] range to interpret as depth.

    Parameters
    ----------
    disparities:
        Raw disparity map.

    Returns
    -------
    np.ndarray
        Normalized depth map.
    """
    disp_min = np.min(disparities)
    disp_max = np.max(disparities)
    if np.isclose(disp_max, disp_min):
        return np.zeros_like(disparities, dtype=np.float32)
    normalized = (disparities - disp_min) / (disp_max - disp_min)
    return normalized.astype(np.float32)


def create_point_cloud(
    depth_map: np.ndarray,
    scale_xy: float = 1.0,
    scale_z: float = 50.0,
) -> np.ndarray:
    """
    Create a point cloud from the depth map.

    Parameters
    ----------
    depth_map:
        Normalized depth map in [0, 1].
    scale_xy:
        Scaling applied to X and Y axes (pixel spacing).
    scale_z:
        Scaling applied to the depth axis to emphasize relief.

    Returns
    -------
    np.ndarray
        Array of shape (N, 3) representing (x, y, z) points.
    """
    height, width = depth_map.shape
    ys, xs = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
    xs = xs.astype(np.float32) * scale_xy
    ys = ys.astype(np.float32) * scale_xy
    zs = depth_map.astype(np.float32) * scale_z
    points = np.stack((xs, ys, zs), axis=-1)
    return points.reshape(-1, 3)


def save_point_cloud_obj(
    path: str,
    depth_map: np.ndarray,
    scale_xy: float = 1.0,
    scale_z: float = 50.0,
) -> None:
    """
    Export the depth map as an OBJ point cloud.

    Parameters
    ----------
    path:
        Destination file path ending in .obj.
    depth_map:
        Normalized depth map in [0, 1].
    scale_xy:
        Horizontal scaling factor.
    scale_z:
        Depth scaling factor.
    """
    points = create_point_cloud(depth_map, scale_xy=scale_xy, scale_z=scale_z)
    with open(path, "w", encoding="utf-8") as obj_file:
        obj_file.write("# Autostereogram recovered point cloud\n")
        for x, y, z in points:
            obj_file.write(f"v {x:.6f} {y:.6f} {z:.6f}\n")

