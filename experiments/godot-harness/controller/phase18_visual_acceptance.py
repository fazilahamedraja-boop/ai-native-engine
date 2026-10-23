#!/usr/bin/env python3
"""Independent visual acceptance checks for the Phase 18 telegraph cue.

This script is deliberately outside the game source and outside the agent
sandbox. It reads only the captured PNGs, the correlated public snapshots, and
the captured HUD text. It does not import the game and does not inspect the
agent's implementation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image


WIDTH = 1280
HEIGHT = 720
CAMERA_FOV_DEG = 62.0
CAMERA_TARGET_HEIGHT = 1.15
BAND_HALF_WIDTH = 170
BAND_BELOW_FEET = 85
BAND_ABOVE_FEET = 10
WARM_MIN_RED = 100
WARM_MIN_DELTA = 35
WARM_EARLY_MIN = 120
WARM_LATE_MIN = 300
ESCALATION_MIN = 1.2
GROUND_IDLE_MAX = 80
GROUND_RECOVERY_MAX = 100
CHANGED_MIN = 300
POSITION_TOLERANCE = 0.12
# The capture loop may advance one extra fixed tick before a paused
# screenshot. A one- or two-tick phase difference is still a like-for-like
# visual comparison; positions and the phase name remain exact.
PHASE_TICK_TOLERANCE = 2


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def vec_sub(a, b):
    return [float(a[i]) - float(b[i]) for i in range(3)]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def cross(a, b):
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def normalize(a):
    length = math.sqrt(dot(a, a))
    if length <= 1e-9:
        return [0.0, 0.0, 0.0]
    return [value / length for value in a]


def project_world(
    state: dict, world: list[float], width: int, height: int
) -> list[float] | None:
    camera = state.get("camera_position")
    player = state.get("player_position")
    if not camera or not player:
        return None
    target = [
        float(player[0]),
        float(player[1]) + CAMERA_TARGET_HEIGHT,
        float(player[2]),
    ]
    forward = normalize(vec_sub(target, camera))
    right = normalize(cross(forward, [0.0, 1.0, 0.0]))
    up = cross(right, forward)
    view = vec_sub(world, camera)
    depth = dot(view, forward)
    if depth <= 0.05:
        return None
    ndc_x = dot(view, right) / (
        depth * math.tan(math.radians(CAMERA_FOV_DEG) / 2.0) * (width / height)
    )
    ndc_y = dot(view, up) / (depth * math.tan(math.radians(CAMERA_FOV_DEG) / 2.0))
    return [
        round((ndc_x + 1.0) * width / 2.0, 2),
        round((1.0 - ndc_y) * height / 2.0, 2),
    ]


def projected_feet(state: dict, width: int, height: int) -> list[float] | None:
    enemy = state.get("enemy_position")
    if not enemy:
        return None
    return project_world(
        state, [float(enemy[0]), float(enemy[1]) + 0.03, float(enemy[2])], width, height
    )


def band_bounds(
    feet: list[float], width: int, height: int
) -> tuple[int, int, int, int]:
    x0 = max(0, int(round(feet[0] - BAND_HALF_WIDTH)))
    x1 = min(width, int(round(feet[0] + BAND_HALF_WIDTH)))
    y0 = max(0, int(round(feet[1] - BAND_ABOVE_FEET)))
    y1 = min(height, int(round(feet[1] + BAND_BELOW_FEET)))
    return x0, y0, x1, y1


def warm_mask(image: np.ndarray) -> np.ndarray:
    red = image[:, :, 0].astype(np.int16)
    green = image[:, :, 1].astype(np.int16)
    blue = image[:, :, 2].astype(np.int16)
    return (
        (red >= WARM_MIN_RED)
        & (red >= green + WARM_MIN_DELTA)
        & (red >= blue + WARM_MIN_DELTA)
    )


def band_metrics(image: np.ndarray, feet: list[float], bounds=None) -> dict:
    x0, y0, x1, y1 = bounds or band_bounds(feet, image.shape[1], image.shape[0])
    crop = image[y0:y1, x0:x1]
    mask = warm_mask(crop)
    return {
        "band": [x0, y0, x1, y1],
        "warm_pixels": int(mask.sum()),
        "crop_pixels": int(mask.size),
        "warm_fraction": float(mask.mean()) if mask.size else 0.0,
    }


def read_image(path: Path) -> np.ndarray:
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--baseline-dir", default=None)
    args = parser.parse_args()

    run_dir = Path(args.run_dir).resolve()
    captures_path = run_dir / "captures.json"
    if not captures_path.exists():
        print(f"missing captures.json in {run_dir}", file=sys.stderr)
        return 2
    captures = load_json(captures_path)
    if isinstance(captures, dict):
        captures = captures.get("captures", captures)
    if not isinstance(captures, list):
        print("captures.json is not a list", file=sys.stderr)
        return 2
    by_name = {str(entry.get("name")): entry for entry in captures}
    checks = []
    metrics = {}

    def check(name, ok, detail):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    def state_of(entry):
        return entry.get("state") or entry.get("state_before") or {}

    def image_of(entry):
        image = entry.get("image") or entry.get("screenshot") or {}
        rel = image.get("path") if isinstance(image, dict) else None
        if not rel:
            return None, None
        path = run_dir / rel
        if not path.exists():
            return None, None
        actual_hash = sha256_file(path)
        expected_hash = image.get("sha256") if isinstance(image, dict) else None
        if expected_hash and actual_hash != expected_hash:
            return None, {
                "hash_mismatch": {"expected": expected_hash, "actual": actual_hash}
            }
        return read_image(path), None

    required = [
        "idle",
        "windup-early",
        "windup-mid",
        "windup-late",
        "active",
        "recovery",
        "restart",
    ]
    for name in required:
        check(
            f"capture-present:{name}",
            name in by_name,
            name if name in by_name else "missing",
        )

    # Correlated state checks. These are facts from the harness snapshot, not
    # image interpretation, and they make the image metrics attributable.
    idle = by_name.get("idle")
    early = by_name.get("windup-early")
    mid = by_name.get("windup-mid")
    late = by_name.get("windup-late")
    active = by_name.get("active")
    recovery = by_name.get("recovery")
    restart = by_name.get("restart")

    if idle:
        s = state_of(idle)
        check("idle-phase", s.get("enemy_phase") == "idle", s.get("enemy_phase"))
        check(
            "idle-ai-disabled",
            s.get("enemy_ai_enabled") is False,
            s.get("enemy_ai_enabled"),
        )
        check(
            "idle-hud-no-warning", "INCOMING" not in str(s.get("hud", "")), s.get("hud")
        )
    if early:
        s = state_of(early)
        check(
            "windup-early-phase",
            s.get("enemy_phase") == "windup"
            and int(s.get("enemy_phase_tick", -1)) >= 16,
            f"{s.get('enemy_phase')}:{s.get('enemy_phase_tick')}",
        )
    if mid:
        s = state_of(mid)
        check(
            "windup-mid-phase",
            s.get("enemy_phase") == "windup"
            and int(s.get("enemy_phase_tick", -1)) >= 21,
            f"{s.get('enemy_phase')}:{s.get('enemy_phase_tick')}",
        )
    if late:
        s = state_of(late)
        check(
            "windup-late-phase",
            s.get("enemy_phase") == "windup"
            and int(s.get("enemy_phase_tick", -1)) >= 24,
            f"{s.get('enemy_phase')}:{s.get('enemy_phase_tick')}",
        )
        check(
            "windup-late-hud-warning",
            "INCOMING ATTACK" in str(s.get("hud", "")),
            s.get("hud"),
        )
    if active:
        s = state_of(active)
        check("active-phase", s.get("enemy_phase") == "active", s.get("enemy_phase"))
    if recovery:
        s = state_of(recovery)
        check("recovery-phase", s.get("enemy_phase") == "recover", s.get("enemy_phase"))
    if restart:
        s = state_of(restart)
        check(
            "restart-clean",
            int(s.get("step", -1)) == 0
            and int(s.get("player_health", -1)) == 4
            and int(s.get("enemy_health", -1)) == 5
            and s.get("outcome") == "playing",
            f"step={s.get('step')} player_hp={s.get('player_health')} enemy_hp={s.get('enemy_health')} outcome={s.get('outcome')}",
        )

    images = {}
    for name in required:
        entry = by_name.get(name)
        if not entry:
            continue
        image, error = image_of(entry)
        if image is None:
            check(f"image-readable:{name}", False, error or "unreadable")
            continue
        check(f"image-readable:{name}", True, {"shape": list(image.shape)})
        if image.shape[1] != WIDTH or image.shape[0] != HEIGHT:
            check(f"image-size:{name}", False, list(image.shape))
        s = state_of(entry)
        feet = entry.get("enemy_feet_screen") or projected_feet(
            s, image.shape[1], image.shape[0]
        )
        if not feet:
            check(f"enemy-projection:{name}", False, "no projection")
            continue
        check(
            f"enemy-projection:{name}",
            0 <= feet[0] < image.shape[1] and 0 <= feet[1] < image.shape[0],
            feet,
        )
        images[name] = image
        metrics[name] = {
            "feet_screen": feet,
            "state": {
                key: s.get(key)
                for key in (
                    "enemy_phase",
                    "enemy_phase_tick",
                    "enemy_position",
                    "player_position",
                    "camera_position",
                    "hud",
                )
            },
            **band_metrics(image, feet),
        }

    # The observable requirement: during late windup, a warm, world-space
    # warning region below the enemy's feet is visible without relying on the
    # HUD. The baseline has no such region; the existing thin blade glow is
    # above the feet and cannot satisfy the ground-band area.
    if "windup-late" in metrics and "idle" in metrics:
        late_m = metrics["windup-late"]
        idle_m = metrics["idle"]
        late_warm = late_m["warm_pixels"]
        idle_warm = idle_m["warm_pixels"]
        check(
            "telegraph-cue-visible-late",
            late_warm >= WARM_LATE_MIN,
            {"warm_pixels": late_warm, "minimum": WARM_LATE_MIN},
        )
        check(
            "telegraph-cue-absent-idle",
            idle_warm <= GROUND_IDLE_MAX,
            {"warm_pixels": idle_warm, "maximum": GROUND_IDLE_MAX},
        )
        check(
            "telegraph-cue-change-over-idle",
            late_warm - idle_warm >= 250,
            {"delta": late_warm - idle_warm, "minimum": 250},
        )
        # Pixel-wise change in the same screen band. This catches a cue that is
        # merely the existing body/sword changing pose, because the baseline
        # windup and idle bands are compared directly.
        if "idle" in images:
            bounds = tuple(late_m["band"])
            x0, y0, x1, y1 = bounds
            a = images["idle"][y0:y1, x0:x1].astype(np.int16)
            b = images["windup-late"][y0:y1, x0:x1].astype(np.int16)
            changed = int((np.max(np.abs(a - b), axis=2) > 28).sum())
            metrics["windup-late"]["changed_pixels_vs_idle"] = changed
            check(
                "telegraph-cue-changes-pixels-vs-idle",
                changed >= CHANGED_MIN,
                {"changed_pixels": changed, "minimum": CHANGED_MIN},
            )
    if "recovery" in metrics:
        check(
            "telegraph-cue-absent-recovery",
            metrics["recovery"]["warm_pixels"] <= GROUND_RECOVERY_MAX,
            {
                "warm_pixels": metrics["recovery"]["warm_pixels"],
                "maximum": GROUND_RECOVERY_MAX,
            },
        )
    if "windup-early" in metrics and "windup-late" in metrics:
        early_warm = metrics["windup-early"]["warm_pixels"]
        late_warm = metrics["windup-late"]["warm_pixels"]
        check(
            "telegraph-cue-escalates",
            late_warm >= early_warm * ESCALATION_MIN,
            {"early": early_warm, "late": late_warm, "minimum_ratio": ESCALATION_MIN},
        )
    if "windup-early" in metrics and "idle" in metrics:
        early_warm = metrics["windup-early"]["warm_pixels"]
        metrics["windup-early"]["warm_delta_vs_idle"] = (
            early_warm - metrics["idle"]["warm_pixels"]
        )
        check(
            "telegraph-cue-present-early",
            early_warm >= WARM_EARLY_MIN
            and early_warm - metrics["idle"]["warm_pixels"] >= 60,
            {
                "warm_pixels": early_warm,
                "minimum": WARM_EARLY_MIN,
                "delta_vs_idle": early_warm - metrics["idle"]["warm_pixels"],
            },
        )

    # Keep the framed comparison honest: if the agent changed player/enemy
    # positions or the camera, the screenshots are not like-for-like evidence.
    if args.baseline_dir:
        baseline_dir = Path(args.baseline_dir).resolve()
        baseline_path = baseline_dir / "captures.json"
        if baseline_path.exists():
            baseline_captures = load_json(baseline_path)
            if isinstance(baseline_captures, dict):
                baseline_captures = baseline_captures.get("captures", baseline_captures)
            baseline_by_name = {
                str(entry.get("name")): entry for entry in baseline_captures
            }
            comparisons = []
            for name in required:
                current = by_name.get(name)
                previous = baseline_by_name.get(name)
                if not current or not previous:
                    continue
                current_state = state_of(current)
                previous_state = state_of(previous)
                row = {"name": name, "ok": True, "differences": {}}
                for field in ("player_position", "enemy_position", "camera_position"):
                    a = previous_state.get(field)
                    b = current_state.get(field)
                    if not a or not b:
                        continue
                    delta = max(abs(float(a[i]) - float(b[i])) for i in range(3))
                    row["differences"][field] = round(delta, 6)
                    if delta > POSITION_TOLERANCE:
                        row["ok"] = False
                for field in ("enemy_phase", "player_health", "enemy_health"):
                    a = previous_state.get(field)
                    b = current_state.get(field)
                    if a != b:
                        row["differences"][field] = [a, b]
                        row["ok"] = False
                a_tick = previous_state.get("enemy_phase_tick")
                b_tick = current_state.get("enemy_phase_tick")
                if a_tick is not None and b_tick is not None:
                    tick_delta = abs(int(a_tick) - int(b_tick))
                    if tick_delta > 0:
                        row["differences"]["enemy_phase_tick"] = [a_tick, b_tick]
                        row["differences"]["enemy_phase_tick_delta"] = tick_delta
                    if tick_delta > PHASE_TICK_TOLERANCE:
                        row["ok"] = False
                comparisons.append(row)
            metrics["baseline_comparison"] = comparisons
            check(
                "framed-states-match-baseline",
                all(row["ok"] for row in comparisons),
                comparisons,
            )
            if "windup-late" in metrics and baseline_captures:
                base_late = next(
                    (e for e in baseline_captures if e.get("name") == "windup-late"),
                    None,
                )
                if base_late:
                    base_image, _ = image_of(base_late)
                    base_state = state_of(base_late)
                    base_feet = base_late.get("enemy_feet_screen") or projected_feet(
                        base_state, WIDTH, HEIGHT
                    )
                    if base_image is not None and base_feet:
                        base_late_metrics = band_metrics(base_image, base_feet)
                        metrics["baseline_windup_late"] = base_late_metrics
                        check(
                            "visual-cue-increased-vs-baseline",
                            metrics["windup-late"]["warm_pixels"]
                            - base_late_metrics["warm_pixels"]
                            >= 250,
                            {
                                "baseline": base_late_metrics["warm_pixels"],
                                "current": metrics["windup-late"]["warm_pixels"],
                            },
                        )
        else:
            check("baseline-available", False, str(baseline_path))

    passed = all(item["ok"] for item in checks)
    report = {
        "schema": "phase18.visual-acceptance.v1",
        "run_dir": str(run_dir),
        "criteria": {
            "ground_band": {
                "half_width": BAND_HALF_WIDTH,
                "above_feet": BAND_ABOVE_FEET,
                "below_feet": BAND_BELOW_FEET,
                "warm_min_red": WARM_MIN_RED,
                "warm_min_delta": WARM_MIN_DELTA,
            },
            "thresholds": {
                "windup_late_warm": WARM_LATE_MIN,
                "idle_warm_max": GROUND_IDLE_MAX,
                "recovery_warm_max": GROUND_RECOVERY_MAX,
                "changed_pixels": CHANGED_MIN,
            },
        },
        "passed": passed,
        "checks": checks,
        "metrics": metrics,
    }
    out_path = Path(args.out) if args.out else run_dir / "visual-acceptance.json"
    out_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": passed, "checks": len(checks), "out": str(out_path)}))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
