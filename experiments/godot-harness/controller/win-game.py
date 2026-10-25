#!/usr/bin/env python
"""Drive and inspect a native Windows game window, with no PowerShell glue.

Phase 19 exported the voxel sandbox to a real `.exe` and then verified it with a
bespoke PowerShell capturer plus hand-written pixel checks. Every later phase
paid that cost again. This script is the reusable version: find a window, focus
it, send real scan-code input, capture it even when it is obscured, read text
out of a region with OCR, and compare images numerically.

    python controller/win-game.py list
    python controller/win-game.py launch voxel/build/voxel-sandbox.exe --title Voxel
    python controller/win-game.py focus  --title Voxel
    python controller/win-game.py key    --title Voxel w --hold 800
    python controller/win-game.py capture --title Voxel --out hud.png --client
    python controller/win-game.py ocr    hud.png --box 0,0,420,120 --scale 3
    python controller/win-game.py analyze hud.png --box 0,0,420,120
    python controller/win-game.py diff   before.png after.png

Every subcommand prints JSON so a Node runner can consume it directly.

Three Windows details this handles that naive versions get wrong:

* `PrintWindow` with `PW_RENDERFULLCONTENT` is required for a GPU-composited
  window (Godot renders through a swap chain, so a plain `BitBlt` yields black).
* The process must be DPI aware before any coordinate is read, or a scaled
  display makes the capture and the click target disagree.
* `pydirectinput` sends scan codes to the *focused* window, so focus is done
  with `AttachThreadInput` rather than a bare `SetForegroundWindow`, which
  Windows blocks from a background process.

OCR accuracy measured on the voxel HUD (1280x720, `voxel-sandbox.exe`): labels
and line structure read correctly, and `bands` locates each row to the pixel,
but single glyphs are not trustworthy - `5.0` was read as `3.0` for the player's
Y coordinate at every scale and PSM that was tried. Thresholding and a
digit-only whitelist made it worse. Treat `ocr` as a reader for text and line
layout; confirm a value that matters (a coordinate, a count) against the crop,
`analyze`, or `diff` rather than trusting one OCR pass.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import shutil
import subprocess
import sys
import time
from ctypes import wintypes
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
except ImportError as error:  # pragma: no cover - environment guard
    sys.exit(f"win-game.py needs Pillow and numpy: {error}")

USER32 = ctypes.WinDLL("user32", use_last_error=True)
GDI32 = ctypes.WinDLL("gdi32", use_last_error=True)

PW_RENDERFULLCONTENT = 0x00000002
SW_RESTORE = 9
TESSERACT_FALLBACK = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def _enable_dpi_awareness() -> str | None:
    """Read and click in physical pixels, not DPI-scaled ones.

    Returns a note when the process could not be made DPI aware, because that
    silently breaks the mapping between a captured pixel and a click target.
    """
    try:
        if USER32.SetProcessDpiAwarenessContext(
            ctypes.c_void_p(-4)
        ):  # PER_MONITOR_AWARE_V2
            return None
        note = "SetProcessDpiAwarenessContext returned false"
    except AttributeError as error:  # pragma: no cover - pre-1607 Windows
        note = f"SetProcessDpiAwarenessContext unavailable: {error}"
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(
            2
        )  # PROCESS_PER_MONITOR_DPI_AWARE
    except (AttributeError, OSError) as error:  # pragma: no cover
        note = f"{note}; shcore fallback failed: {error}"
    return note


DPI_AWARENESS_WARNING = _enable_dpi_awareness()


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def _window_pid(hwnd: int) -> int:
    pid = wintypes.DWORD()
    USER32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def _window_title(hwnd: int) -> str:
    length = USER32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    USER32.GetWindowTextW(hwnd, buffer, length + 1)
    return buffer.value


def _is_visible(hwnd: int) -> bool:
    return bool(USER32.IsWindowVisible(hwnd))


def list_windows(match: str | None = None) -> list[dict]:
    """Every visible top-level window, optionally filtered by title substring."""
    windows: list[dict] = []
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def callback(hwnd, _lparam):
        if not _is_visible(hwnd):
            return True
        title = _window_title(hwnd)
        if not title:
            return True
        if match and match.lower() not in title.lower():
            return True
        rect = wintypes.RECT()
        USER32.GetWindowRect(hwnd, ctypes.byref(rect))
        windows.append(
            {
                "hwnd": int(hwnd),
                "pid": _window_pid(hwnd),
                "title": title,
                "rect": {
                    "left": rect.left,
                    "top": rect.top,
                    "width": rect.right - rect.left,
                    "height": rect.bottom - rect.top,
                },
            }
        )
        return True

    USER32.EnumWindows(enum_proc(callback), 0)
    return windows


def find_window(
    title: str | None = None, timeout: float = 0.0, pid: int | None = None
) -> int:
    """Resolve a window by title substring and/or owning process, waiting if asked.

    A title alone is ambiguous in practice: a browser tab titled after the game
    matches the same substring as the game itself. Callers that know the process
    pass `pid` and get the right window.
    """
    if not title and not pid:
        raise SystemExit("give --title and/or --pid to identify a window")
    deadline = time.monotonic() + timeout
    while True:
        candidates = list_windows(title)
        if pid:
            candidates = [item for item in candidates if item["pid"] == pid]
        if candidates:
            # Prefer the largest match: a launcher or splash is usually smaller
            # than the window it opens.
            candidates.sort(
                key=lambda item: item["rect"]["width"] * item["rect"]["height"],
                reverse=True,
            )
            return candidates[0]["hwnd"]
        if time.monotonic() >= deadline:
            wanted = " ".join(
                part
                for part in (
                    f"title~{title!r}" if title else "",
                    f"pid={pid}" if pid else "",
                )
                if part
            )
            raise SystemExit(f"no visible window matching {wanted}")
        time.sleep(0.25)


def focus_window(hwnd: int) -> None:
    """Bring `hwnd` to the foreground despite the Windows foreground lock."""
    if USER32.IsIconic(hwnd):
        USER32.ShowWindow(hwnd, SW_RESTORE)
    target_thread = USER32.GetWindowThreadProcessId(hwnd, None)
    current_thread = ctypes.WinDLL("kernel32").GetCurrentThreadId()
    attached = False
    if target_thread and target_thread != current_thread:
        attached = bool(USER32.AttachThreadInput(current_thread, target_thread, True))
    try:
        USER32.BringWindowToTop(hwnd)
        USER32.SetForegroundWindow(hwnd)
        USER32.SetActiveWindow(hwnd)
    finally:
        if attached:
            USER32.AttachThreadInput(current_thread, target_thread, False)
    time.sleep(0.15)


def capture(hwnd: int, client_only: bool = False) -> Image.Image:
    """Capture a window with `PrintWindow`, which works while it is obscured."""
    rect = wintypes.RECT()
    USER32.GetWindowRect(hwnd, ctypes.byref(rect))
    full_w, full_h = rect.right - rect.left, rect.bottom - rect.top
    if full_w <= 0 or full_h <= 0:
        raise SystemExit(f"window {hwnd} has an empty rect ({full_w}x{full_h})")

    hwnd_dc = USER32.GetWindowDC(hwnd)
    if not hwnd_dc:
        raise SystemExit("GetWindowDC failed")
    mem_dc = GDI32.CreateCompatibleDC(hwnd_dc)
    bitmap = GDI32.CreateCompatibleBitmap(hwnd_dc, full_w, full_h)
    previous = GDI32.SelectObject(mem_dc, bitmap)
    try:
        if not USER32.PrintWindow(hwnd, mem_dc, PW_RENDERFULLCONTENT):
            raise SystemExit("PrintWindow failed; the window may be on another desktop")
        header = BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        header.biWidth = full_w
        header.biHeight = -full_h  # top-down rows
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = 0  # BI_RGB
        info = BITMAPINFO()
        info.bmiHeader = header
        buffer = ctypes.create_string_buffer(full_w * full_h * 4)
        if not GDI32.GetDIBits(
            mem_dc, bitmap, 0, full_h, buffer, ctypes.byref(info), 0
        ):
            raise SystemExit("GetDIBits failed")
        image = Image.frombuffer(
            "RGB", (full_w, full_h), buffer, "raw", "BGRX", 0, 1
        ).copy()
    finally:
        GDI32.SelectObject(mem_dc, previous)
        GDI32.DeleteObject(bitmap)
        GDI32.DeleteDC(mem_dc)
        USER32.ReleaseDC(hwnd, hwnd_dc)

    if client_only:
        client = wintypes.RECT()
        USER32.GetClientRect(hwnd, ctypes.byref(client))
        origin = wintypes.POINT(0, 0)
        USER32.ClientToScreen(hwnd, ctypes.byref(origin))
        left = origin.x - rect.left
        top = origin.y - rect.top
        image = image.crop((left, top, left + client.right, top + client.bottom))
    return image


def parse_box(text: str | None, size: tuple[int, int]) -> tuple[int, int, int, int]:
    """`x,y,w,h` in image pixels; defaults to the whole image."""
    if not text:
        return 0, 0, size[0], size[1]
    try:
        left, top, width, height = (int(part) for part in text.split(","))
    except ValueError:
        raise SystemExit(f"--box expects x,y,w,h (got {text!r})")
    if left < 0 or top < 0 or width <= 0 or height <= 0:
        raise SystemExit(f"--box is out of range: {text!r}")
    if left + width > size[0] or top + height > size[1]:
        raise SystemExit(f"--box {text} exceeds the {size[0]}x{size[1]} image")
    return left, top, width, height


def tesseract_binary() -> str:
    found = shutil.which("tesseract")
    if found:
        return found
    if os.path.exists(TESSERACT_FALLBACK):
        return TESSERACT_FALLBACK
    raise SystemExit("tesseract not found on PATH or in Program Files")


def cmd_list(args) -> dict:
    return {"windows": list_windows(args.title)}


def cmd_launch(args) -> dict:
    exe = Path(args.exe).resolve()
    if not exe.exists():
        raise SystemExit(f"no such executable: {exe}")
    process = subprocess.Popen([str(exe)], cwd=str(exe.parent))

    # Match on the process we just started, never on the title alone: a browser
    # tab named after the game matches the same substring and is larger, so a
    # title-first search happily drives the wrong window.
    deadline = time.monotonic() + args.timeout
    hwnd = None
    while time.monotonic() < deadline:
        owned = [
            item for item in list_windows(args.title) if item["pid"] == process.pid
        ]
        if owned:
            owned.sort(
                key=lambda item: item["rect"]["width"] * item["rect"]["height"],
                reverse=True,
            )
            hwnd = owned[0]["hwnd"]
            break
        code = process.poll()
        if code is not None:
            raise SystemExit(
                f"{exe.name} exited with code {code} before opening a window"
            )
        time.sleep(0.25)
    if hwnd is None:
        raise SystemExit(f"{exe.name} opened no visible window within {args.timeout}s")
    if args.focus:
        focus_window(hwnd)
    return {
        "pid": process.pid,
        "window": {
            "hwnd": hwnd,
            "title": _window_title(hwnd),
            "pid": _window_pid(hwnd),
        },
    }


def cmd_focus(args) -> dict:
    hwnd = find_window(args.title, timeout=args.timeout, pid=args.pid)
    focus_window(hwnd)
    foreground = USER32.GetForegroundWindow()
    return {
        "hwnd": hwnd,
        "title": _window_title(hwnd),
        "focused": foreground == hwnd,
        "foreground": {"hwnd": int(foreground), "title": _window_title(foreground)},
    }


def _save_capture(hwnd: int, path_text: str, client_only: bool) -> dict:
    image = capture(hwnd, client_only=client_only)
    out = Path(path_text).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    image.save(out)
    return {
        "path": str(out),
        "size": {"width": image.width, "height": image.height},
    }


def _maybe_capture(args, hwnd: int) -> dict | None:
    if not getattr(args, "capture", None):
        return None
    if args.capture_delay:
        time.sleep(args.capture_delay / 1000.0)
    return _save_capture(hwnd, args.capture, args.client)


def cmd_key(args) -> dict:
    import pydirectinput

    hwnd = find_window(args.title, timeout=args.timeout, pid=args.pid)
    focus_window(hwnd)
    pydirectinput.PAUSE = 0.02
    sent = []
    for name in args.keys:
        key = name.lower()
        if key not in pydirectinput.KEYBOARD_MAPPING and len(key) > 1:
            raise SystemExit(f"unknown key name: {name}")
        if args.hold:
            pydirectinput.keyDown(key)
            time.sleep(args.hold / 1000.0)
            pydirectinput.keyUp(key)
        else:
            pydirectinput.press(key)
        sent.append(key)
    payload = {"hwnd": hwnd, "keys": sent, "hold_ms": args.hold, "repeat": args.repeat}
    shot = _maybe_capture(args, hwnd)
    if shot:
        payload["capture"] = shot
    return payload


def cmd_mouse(args) -> dict:
    import pydirectinput

    hwnd = find_window(args.title, timeout=args.timeout, pid=args.pid)
    focus_window(hwnd)
    if args.click:
        x, y = (int(part) for part in args.click.split(","))
        pydirectinput.click(x=x, y=y, button=args.button)
        payload = {"hwnd": hwnd, "clicked": {"x": x, "y": y, "button": args.button}}
    elif args.move_rel:
        dx, dy = (int(part) for part in args.move_rel.split(","))
        pydirectinput.moveRel(dx, dy, relative=True)
        payload = {"hwnd": hwnd, "moved": {"dx": dx, "dy": dy}}
    else:
        raise SystemExit("mouse needs --click x,y or --move-rel dx,dy")
    shot = _maybe_capture(args, hwnd)
    if shot:
        payload["capture"] = shot
    return payload


def cmd_capture(args) -> dict:
    hwnd = find_window(args.title, timeout=args.timeout, pid=args.pid)
    shot = _save_capture(hwnd, args.out, args.client)
    return {
        "hwnd": hwnd,
        "title": _window_title(hwnd),
        "path": shot["path"],
        "size": shot["size"],
        "client_only": args.client,
    }


def cmd_bands(args) -> dict:
    """Locate horizontal text bands inside a region.

    Reading a HUD line by guessing its y offset produces OCR results that vary
    with the window size; locating the bands first makes the crop exact and the
    numbers repeatable.
    """
    path = Path(args.image).resolve()
    image = Image.open(path)
    left, top, width, height = parse_box(args.box, image.size)
    array = _region_array(image, (left, top, width, height))
    if args.mode == "edges":
        # Text against a bright sky or a dark panel is still text: horizontal
        # gradient energy finds it where an absolute luminance threshold cannot.
        gray = array.mean(axis=2)
        gradient = np.abs(np.diff(gray, axis=1))
        mask = np.zeros(gray.shape, dtype=bool)
        mask[:, : gradient.shape[1]] = gradient >= args.min_gradient
    else:
        luma = array.max(axis=2)
        mask = luma <= args.min_luma if args.mode == "dark" else luma >= args.min_luma

    row_share = mask.mean(axis=1)
    row_hit = row_share >= args.min_share
    spans: list[list[int]] = []
    for index, hit in enumerate(row_hit):
        if not hit:
            continue
        if spans and index - (spans[-1][0] + spans[-1][1]) <= args.merge_gap:
            spans[-1][1] = index - spans[-1][0] + 1
        else:
            spans.append([index, 1])

    bands = []
    for offset, band_height in spans:
        if band_height < args.min_height:
            continue
        columns = mask[offset : offset + band_height].any(axis=0)
        indexes = np.where(columns)[0]
        bands.append(
            {
                "y": top + offset,
                "height": band_height,
                "x": left + int(indexes[0]),
                "width": int(indexes[-1] - indexes[0] + 1),
                "fill": round(float(mask[offset : offset + band_height].mean()), 4),
            }
        )
    return {
        "image": str(path),
        "box": {"x": left, "y": top, "width": width, "height": height},
        "mode": args.mode,
        "minLuma": args.min_luma if args.mode != "edges" else None,
        "minGradient": args.min_gradient if args.mode == "edges" else None,
        "bands": bands,
    }


def cmd_ocr(args) -> dict:
    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = tesseract_binary()
    path = Path(args.image).resolve()
    image = Image.open(path)
    left, top, width, height = parse_box(args.box, image.size)
    region = image.crop((left, top, left + width, top + height))
    if args.scale != 1:
        region = region.resize(
            (region.width * args.scale, region.height * args.scale), Image.LANCZOS
        )
    if args.grayscale:
        region = region.convert("L")
    config = f"--psm {args.psm}"
    if args.whitelist:
        config += f" -c tessedit_char_whitelist={args.whitelist}"
    text = pytesseract.image_to_string(region, config=config)
    return {
        "image": str(path),
        "box": {"x": left, "y": top, "width": width, "height": height},
        "scale": args.scale,
        "psm": args.psm,
        "text": text.strip(),
        "lines": [
            line for line in (part.strip() for part in text.splitlines()) if line
        ],
    }


def _region_array(image: Image.Image, box: tuple[int, int, int, int]) -> np.ndarray:
    left, top, width, height = box
    return np.asarray(
        image.crop((left, top, left + width, top + height)).convert("RGB"),
        dtype=np.int16,
    )


def cmd_analyze(args) -> dict:
    path = Path(args.image).resolve()
    image = Image.open(path)
    box = parse_box(args.box, image.size)
    array = _region_array(image, box)
    pixels = array.reshape(-1, 3)

    # Quantise to 4 bits per channel so "how many distinct colours" is a
    # meaningful number on antialiased UI text instead of ~every pixel.
    quantised = (pixels // 16).astype(np.int32)
    keys = quantised[:, 0] * 256 + quantised[:, 1] * 16 + quantised[:, 2]
    values, counts = np.unique(keys, return_counts=True)
    order = np.argsort(counts)[::-1][: args.colors]
    total = int(counts.sum())
    dominant = []
    for index in order:
        key = int(values[index])
        mask = keys == key
        mean = pixels[mask].mean(axis=0).astype(int).tolist()
        dominant.append(
            {
                "rgb": mean,
                "hex": "#{:02x}{:02x}{:02x}".format(*mean),
                "share": round(float(counts[index]) / total, 4),
            }
        )

    return {
        "image": str(path),
        "imageSize": {"width": image.width, "height": image.height},
        "box": {"x": box[0], "y": box[1], "width": box[2], "height": box[3]},
        "meanRgb": [round(float(value), 2) for value in pixels.mean(axis=0)],
        "stdRgb": [round(float(value), 2) for value in pixels.std(axis=0)],
        "distinctColors4bit": int(values.size),
        "nonBlackFraction": round(float((pixels.max(axis=1) > 8).mean()), 4),
        "dominant": dominant,
    }


def cmd_diff(args) -> dict:
    first = Image.open(Path(args.before).resolve())
    second = Image.open(Path(args.after).resolve())
    if first.size != second.size:
        return {
            "before": args.before,
            "after": args.after,
            "sizeMismatch": {"before": first.size, "after": second.size},
        }
    box = parse_box(args.box, first.size)
    a = _region_array(first, box)
    b = _region_array(second, box)
    delta = np.abs(a - b).max(axis=2)
    changed = delta > args.threshold
    changed_count = int(changed.sum())
    result = {
        "before": args.before,
        "after": args.after,
        "box": {"x": box[0], "y": box[1], "width": box[2], "height": box[3]},
        "threshold": args.threshold,
        "changedPixels": changed_count,
        "changedFraction": round(changed_count / changed.size, 6),
        "meanAbsDiff": round(float(np.abs(a - b).mean()), 3),
        "maxAbsDiff": int(delta.max()),
    }
    if changed_count:
        rows = np.where(changed.any(axis=1))[0]
        cols = np.where(changed.any(axis=0))[0]
        result["changedBounds"] = {
            "x": int(cols[0]),
            "y": int(rows[0]),
            "width": int(cols[-1] - cols[0] + 1),
            "height": int(rows[-1] - rows[0] + 1),
        }
    return result


def cmd_close(args) -> dict:
    hwnd = find_window(args.title, timeout=args.timeout, pid=args.pid)
    pid = _window_pid(hwnd)
    USER32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    time.sleep(0.5)
    return {"hwnd": hwnd, "pid": pid, "stillVisible": bool(USER32.IsWindow(hwnd))}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_title(sub, timeout_default=0.0):
        sub.add_argument("--title", help="case-insensitive window-title substring")
        sub.add_argument(
            "--pid", type=int, help="owning process id (disambiguates a title)"
        )
        sub.add_argument(
            "--timeout",
            type=float,
            default=timeout_default,
            help="seconds to wait for the window",
        )

    listing = subparsers.add_parser("list", help="list visible windows")
    listing.add_argument("--title", help="filter by title substring")
    listing.set_defaults(func=cmd_list)

    launch = subparsers.add_parser(
        "launch", help="start an executable and find its window"
    )
    launch.add_argument("exe")
    add_title(launch, timeout_default=60.0)
    launch.add_argument("--focus", action="store_true")
    launch.set_defaults(func=cmd_launch)

    focus = subparsers.add_parser("focus", help="bring a window to the foreground")
    add_title(focus)
    focus.set_defaults(func=cmd_focus)

    key = subparsers.add_parser("key", help="send real scan-code keystrokes")
    add_title(key)
    key.add_argument("keys", nargs="+")
    key.add_argument("--hold", type=int, default=0, help="hold each key this many ms")
    key.add_argument("--repeat", type=int, default=1)
    key.set_defaults(func=cmd_key)

    mouse = subparsers.add_parser("mouse", help="click or move relative to the cursor")
    add_title(mouse)
    mouse.add_argument("--click", help="absolute screen x,y")
    mouse.add_argument("--move-rel", help="relative dx,dy (use for pointer-lock games)")
    mouse.add_argument("--button", default="left", choices=["left", "right", "middle"])
    mouse.set_defaults(func=cmd_mouse)

    # Capturing in the same process as the input is what makes a timing-sensitive
    # check possible: a second CLI call spends ~150 ms on interpreter startup,
    # which is longer than a jump's airborne window.
    for action in (key, mouse):
        action.add_argument("--capture", help="also save a PNG right after the input")
        action.add_argument(
            "--capture-delay",
            type=int,
            default=0,
            dest="capture_delay",
            help="ms to wait first",
        )
        action.add_argument(
            "--client", action="store_true", help="capture the client area only"
        )

    shot = subparsers.add_parser("capture", help="capture a window to PNG")
    add_title(shot)
    shot.add_argument("--out", required=True)
    shot.add_argument("--client", action="store_true", help="crop to the client area")
    shot.set_defaults(func=cmd_capture)

    bands = subparsers.add_parser("bands", help="locate text rows inside a region")
    bands.add_argument("image")
    bands.add_argument("--box", help="x,y,w,h")
    bands.add_argument("--mode", default="bright", choices=["bright", "dark", "edges"])
    bands.add_argument("--min-luma", type=int, default=200, dest="min_luma")
    bands.add_argument(
        "--min-gradient",
        type=int,
        default=12,
        dest="min_gradient",
        help="for --mode edges",
    )
    bands.add_argument(
        "--min-share",
        type=float,
        default=0.02,
        dest="min_share",
        help="row pixel fraction to count as text",
    )
    bands.add_argument("--merge-gap", type=int, default=3, dest="merge_gap")
    bands.add_argument("--min-height", type=int, default=4, dest="min_height")
    bands.set_defaults(func=cmd_bands)

    ocr = subparsers.add_parser("ocr", help="read text from an image region")
    ocr.add_argument("image")
    ocr.add_argument("--box", help="x,y,w,h")
    ocr.add_argument("--scale", type=int, default=1, help="upscale before OCR")
    ocr.add_argument("--psm", type=int, default=6)
    ocr.add_argument("--whitelist", default="")
    ocr.add_argument("--grayscale", action="store_true")
    ocr.set_defaults(func=cmd_ocr)

    analyze = subparsers.add_parser("analyze", help="colour statistics for a region")
    analyze.add_argument("image")
    analyze.add_argument("--box", help="x,y,w,h")
    analyze.add_argument("--colors", type=int, default=6)
    analyze.set_defaults(func=cmd_analyze)

    diff = subparsers.add_parser("diff", help="numeric difference between two images")
    diff.add_argument("before")
    diff.add_argument("after")
    diff.add_argument("--box", help="x,y,w,h")
    diff.add_argument("--threshold", type=int, default=8)
    diff.set_defaults(func=cmd_diff)

    close = subparsers.add_parser("close", help="ask a window to close")
    add_title(close)
    close.set_defaults(func=cmd_close)

    return parser


def main() -> int:
    # Window titles contain arbitrary Unicode; the Windows console default
    # code page would raise on the first emoji and truncate the JSON.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = build_parser().parse_args()
    try:
        payload = args.func(args)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - the CLI reports, the caller decides
        print(
            json.dumps({"error": type(error).__name__, "message": str(error)}, indent=2)
        )
        return 1
    if DPI_AWARENESS_WARNING:
        payload["dpiAwarenessWarning"] = DPI_AWARENESS_WARNING
    print(json.dumps({"ok": True, **payload}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
