extends RefCounted

## Pure enemy state machine for the Phase 16 prototype.
##
## It owns health, posture, and attack timing but no scene nodes, so the exact
## same rules run under the live game and the acceptance tests. All timings are
## integer physics ticks, which makes a telegraphed attack reproducible.

const MAX_HEALTH := 5
const MAX_POSTURE := 100.0

const WINDUP_TICKS := 30
const ACTIVE_TICKS := 9
const RECOVER_TICKS := 18
const COOLDOWN_TICKS := 22
const STAGGER_TICKS := 70

const ATTACK_RANGE := 2.3
const POSTURE_PER_HIT := 16.0
const POSTURE_PER_PARRY := 55.0
const POSTURE_DECAY_PER_TICK := 0.35

var health := MAX_HEALTH
var posture := 0.0
var phase := "idle"
var phase_tick := 0
var cooldown := 0
var stagger_ticks := 0

## Per-tick flags, cleared by tick().
var attack_started := false
var entered_active := false
var damage_window := false


func reset() -> void:
	health = MAX_HEALTH
	posture = 0.0
	phase = "idle"
	phase_tick = 0
	cooldown = 0
	stagger_ticks = 0
	attack_started = false
	entered_active = false
	damage_window = false


func tick(distance: float) -> void:
	attack_started = false
	entered_active = false
	damage_window = false

	if phase == "defeated":
		return
	if phase == "stagger":
		stagger_ticks -= 1
		if stagger_ticks <= 0:
			phase = "idle"
			phase_tick = 0
			cooldown = COOLDOWN_TICKS
		return

	posture = maxf(0.0, posture - POSTURE_DECAY_PER_TICK)

	if phase == "windup":
		phase_tick += 1
		if phase_tick >= WINDUP_TICKS:
			phase = "active"
			phase_tick = 0
			entered_active = true
		return

	if phase == "active":
		phase_tick += 1
		if phase_tick == 1:
			damage_window = true
		if phase_tick >= ACTIVE_TICKS:
			phase = "recover"
			phase_tick = 0
		return

	if phase == "recover":
		phase_tick += 1
		if phase_tick >= RECOVER_TICKS:
			phase = "idle"
			phase_tick = 0
			cooldown = COOLDOWN_TICKS
		return

	if phase == "approach":
		if distance <= ATTACK_RANGE:
			phase = "idle"
			phase_tick = 0
		return

	# idle
	if cooldown > 0:
		cooldown -= 1
		return
	if distance <= ATTACK_RANGE:
		phase = "windup"
		phase_tick = 0
		attack_started = true


func should_approach() -> bool:
	return phase == "approach"


func is_attacking() -> bool:
	return phase == "windup" or phase == "active" or phase == "recover"


func is_defeated() -> bool:
	return phase == "defeated"


func is_staggered() -> bool:
	return phase == "stagger"


func telegraphing() -> bool:
	return phase == "windup" or (phase == "active" and phase_tick <= 3)


func apply_hit() -> void:
	if phase == "defeated":
		return
	health -= 1
	posture += POSTURE_PER_HIT
	if health <= 0:
		health = 0
		phase = "defeated"
		phase_tick = 0
		stagger_ticks = 0
	elif posture >= MAX_POSTURE:
		_enter_stagger()


func apply_parry() -> void:
	if phase == "defeated":
		return
	posture += POSTURE_PER_PARRY
	if posture >= MAX_POSTURE:
		_enter_stagger()


func _enter_stagger() -> void:
	phase = "stagger"
	phase_tick = 0
	stagger_ticks = STAGGER_TICKS
	posture = 0.0
	damage_window = false
	entered_active = false


func phase_progress() -> float:
	match phase:
		"windup":
			return float(phase_tick) / float(WINDUP_TICKS)
		"active":
			return float(phase_tick) / float(ACTIVE_TICKS)
		"recover":
			return float(phase_tick) / float(RECOVER_TICKS)
		"stagger":
			return 1.0 - float(stagger_ticks) / float(STAGGER_TICKS)
		_:
			return 0.0
