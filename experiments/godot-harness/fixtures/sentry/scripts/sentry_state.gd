class_name SentryState
extends RefCounted

## Pure sentry rules. This file has no scene, renderer, or clock dependency so
## the state machine can be tested headlessly with fixed ticks.

enum Phase { ACTIVE, WON, LOST }

const FILL_PER_STEP := 1.0 / 90.0
const DECAY_PER_STEP := 1.0 / 180.0
const EXIT_RADIUS := 2.0

var phase: Phase = Phase.ACTIVE
var detection := 0.0
var seen_by: Array[String] = []

## Guards face +Z. The player starts at the origin and walks toward -Z.
var guards: Array[Dictionary] = [
	{
		"id": "guard-a",
		"pos": Vector3(0.0, 0.0, -7.0),
		"range": 5.5,
		"half_angle_deg": 35.0,
		"forward": Vector3(0.0, 0.0, 1.0),
	},
	{
		"id": "guard-b",
		"pos": Vector3(0.0, 0.0, -13.0),
		"range": 5.5,
		"half_angle_deg": 35.0,
		"forward": Vector3(0.0, 0.0, 1.0),
	},
]

var exit_pos := Vector3(0.0, 0.8, -18.0)


func reset() -> void:
	phase = Phase.ACTIVE
	detection = 0.0
	seen_by.clear()


func is_active() -> bool:
	return phase == Phase.ACTIVE


func seeing_guards(player_pos: Vector3) -> Array[String]:
	var seen: Array[String] = []
	for guard in guards:
		if _guard_sees(guard, player_pos):
			seen.append(String(guard["id"]))
	return seen


## Advance exactly one fixed simulation step. Detection is horizontal-only,
## matching the reference game's line-of-sight test.
func tick(player_pos: Vector3) -> void:
	if phase != Phase.ACTIVE:
		return

	seen_by = seeing_guards(player_pos)

	if seen_by.size() > 0:
		detection = minf(1.0, detection + FILL_PER_STEP)
	else:
		detection = maxf(0.0, detection - DECAY_PER_STEP)

	# Loss wins over a same-step exit. The epsilon covers accumulated float
	# addition, as in the reference implementation.
	if detection >= 1.0 - 0.000000001:
		detection = 1.0
		phase = Phase.LOST
		return

	if exit_distance(player_pos) <= EXIT_RADIUS:
		phase = Phase.WON


func exit_distance(player_pos: Vector3) -> float:
	var dx := player_pos.x - exit_pos.x
	var dz := player_pos.z - exit_pos.z
	return sqrt(dx * dx + dz * dz)


func phase_name() -> String:
	match phase:
		Phase.WON:
			return "won"
		Phase.LOST:
			return "lost"
		_:
			return "active"


func snapshot(player_pos: Vector3) -> Dictionary:
	return {
		"phase": phase_name(),
		"detection": detection,
		"detection_percent": int(round(detection * 100.0)),
		"seen_by": seeing_guards(player_pos),
		"exit_distance": exit_distance(player_pos),
	}


func signature() -> String:
	return "phase=%s detection=%.6f seen=%s" % [
		phase_name(),
		detection,
		",".join(seen_by),
	]


func _guard_sees(guard: Dictionary, player_pos: Vector3) -> bool:
	var origin: Vector3 = guard["pos"]
	var sight_range: float = guard["range"]
	var half_angle_deg: float = guard["half_angle_deg"]
	var forward: Vector3 = guard["forward"]

	var dx := player_pos.x - origin.x
	var dz := player_pos.z - origin.z
	var distance := sqrt(dx * dx + dz * dz)
	if distance <= 0.000000001:
		return true
	if distance > sight_range:
		return false

	var direction := Vector3(dx, 0.0, dz) / distance
	var cos_half_angle := cos(deg_to_rad(half_angle_deg))
	return direction.dot(forward.normalized()) >= cos_half_angle
