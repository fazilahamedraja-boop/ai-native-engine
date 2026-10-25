"""Tests for the window-free parts of `controller/win-game.py`.

Capture, focus and input need a real game window, which `docs/phase19` covers
with an actual run. What is testable here is the analysis layer: region parsing,
text-band detection, colour statistics and image differencing. Those are the
parts most likely to be reused and silently broken by an edit.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

MODULE_PATH = Path(__file__).resolve().parents[1] / "controller" / "win-game.py"
SPEC = importlib.util.spec_from_file_location("win_game", MODULE_PATH)
assert SPEC and SPEC.loader
win_game = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(win_game)


class Args:
    """Minimal stand-in for the argparse namespace the commands read."""

    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def text_image(path: Path, rows: list[tuple[int, int]]) -> Path:
    """Dark canvas with white bars at the given `(top, height)` row ranges."""
    image = Image.new("RGB", (200, 100), (30, 30, 30))
    draw = ImageDraw.Draw(image)
    for top, height in rows:
        draw.rectangle((20, top, 180, top + height - 1), fill=(255, 255, 255))
    image.save(path)
    return path


def test_parse_box_defaults_to_the_whole_image():
    assert win_game.parse_box(None, (640, 480)) == (0, 0, 640, 480)


def test_parse_box_reads_x_y_w_h():
    assert win_game.parse_box("10,20,30,40", (640, 480)) == (10, 20, 30, 40)


def test_parse_box_rejects_malformed_input():
    with pytest.raises(SystemExit):
        win_game.parse_box("10,20,30", (640, 480))
    with pytest.raises(SystemExit):
        win_game.parse_box("10,20,0,40", (640, 480))


def test_parse_box_rejects_a_region_outside_the_image():
    with pytest.raises(SystemExit):
        win_game.parse_box("600,0,100,100", (640, 480))


def test_bands_finds_two_bright_rows(tmp_path: Path):
    image = text_image(tmp_path / "bars.png", [(10, 10), (40, 10)])
    result = win_game.cmd_bands(
        Args(
            image=str(image),
            box=None,
            mode="bright",
            min_luma=200,
            min_gradient=12,
            min_share=0.02,
            merge_gap=3,
            min_height=4,
        )
    )
    bands = result["bands"]
    assert [band["y"] for band in bands] == [10, 40]
    assert [band["height"] for band in bands] == [10, 10]
    assert all(band["x"] == 20 and band["width"] == 161 for band in bands)


def test_bands_edges_mode_ignores_flat_bright_background(tmp_path: Path):
    """A bright sky is not text; edge energy is what distinguishes them."""
    image = Image.new("RGB", (200, 100), (200, 220, 240))
    draw = ImageDraw.Draw(image)
    # Letter-like vertical strokes: many horizontal transitions per row, which
    # is what real glyphs provide and a solid block does not.
    for x in range(20, 180, 10):
        draw.rectangle((x, 50, x + 3, 58), fill=(250, 250, 250))
    path = tmp_path / "sky.png"
    image.save(path)

    bright = win_game.cmd_bands(
        Args(
            image=str(path),
            box=None,
            mode="bright",
            min_luma=200,
            min_gradient=12,
            min_share=0.02,
            merge_gap=3,
            min_height=4,
        )
    )
    edges = win_game.cmd_bands(
        Args(
            image=str(path),
            box=None,
            mode="edges",
            min_luma=200,
            min_gradient=12,
            min_share=0.02,
            merge_gap=3,
            min_height=4,
        )
    )
    # Luminance alone finds one band spanning the whole sky.
    assert len(bright["bands"]) == 1
    assert bright["bands"][0]["height"] == 100
    # Only the strokes produce edge energy, and they form one band.
    assert [band["y"] for band in edges["bands"]] == [50]
    assert edges["bands"][0]["height"] == 9


def test_bands_can_be_limited_to_a_box(tmp_path: Path):
    image = text_image(tmp_path / "bars.png", [(10, 10), (40, 10)])
    result = win_game.cmd_bands(
        Args(
            image=str(image),
            box="0,30,200,60",
            mode="bright",
            min_luma=200,
            min_gradient=12,
            min_share=0.02,
            merge_gap=3,
            min_height=4,
        )
    )
    # Only the bar at y=40 falls inside the requested box.
    assert [band["y"] for band in result["bands"]] == [40]


def test_analyze_reports_a_solid_region(tmp_path: Path):
    path = tmp_path / "solid.png"
    Image.new("RGB", (40, 40), (255, 0, 0)).save(path)
    result = win_game.cmd_analyze(Args(image=str(path), box=None, colors=4))
    assert result["meanRgb"] == [255.0, 0.0, 0.0]
    assert result["stdRgb"] == [0.0, 0.0, 0.0]
    assert result["distinctColors4bit"] == 1
    assert result["nonBlackFraction"] == 1.0
    assert result["dominant"][0]["hex"] == "#ff0000"


def test_analyze_counts_a_black_region_as_empty(tmp_path: Path):
    path = tmp_path / "black.png"
    Image.new("RGB", (10, 10), (0, 0, 0)).save(path)
    result = win_game.cmd_analyze(Args(image=str(path), box=None, colors=4))
    assert result["nonBlackFraction"] == 0.0


def test_diff_locates_the_changed_rectangle(tmp_path: Path):
    before = Image.new("RGB", (100, 100), (0, 0, 0))
    after = before.copy()
    ImageDraw.Draw(after).rectangle((10, 20, 29, 39), fill=(255, 255, 255))
    left, right = tmp_path / "a.png", tmp_path / "b.png"
    before.save(left)
    after.save(right)

    result = win_game.cmd_diff(
        Args(before=str(left), after=str(right), box=None, threshold=8)
    )
    assert result["changedPixels"] == 400
    assert result["changedFraction"] == 400 / 10000
    assert result["changedBounds"] == {"x": 10, "y": 20, "width": 20, "height": 20}
    assert result["maxAbsDiff"] == 255


def test_diff_ignores_change_below_the_threshold(tmp_path: Path):
    before = Image.new("RGB", (10, 10), (100, 100, 100))
    after = Image.new("RGB", (10, 10), (104, 104, 104))
    left, right = tmp_path / "a.png", tmp_path / "b.png"
    before.save(left)
    after.save(right)

    result = win_game.cmd_diff(
        Args(before=str(left), after=str(right), box=None, threshold=8)
    )
    assert result["changedPixels"] == 0
    assert "changedBounds" not in result


def test_diff_reports_a_size_mismatch_instead_of_comparing(tmp_path: Path):
    left = tmp_path / "a.png"
    right = tmp_path / "b.png"
    Image.new("RGB", (10, 10)).save(left)
    Image.new("RGB", (10, 11)).save(right)

    result = win_game.cmd_diff(
        Args(before=str(left), after=str(right), box=None, threshold=8)
    )
    assert result["sizeMismatch"] == {"before": (10, 10), "after": (10, 11)}
