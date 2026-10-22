extends SceneTree

## Phase 17 dodge-roll acceptance suite (runner-owned).
##
## This file is intentionally not copied into the agent's sandbox. It treats
## the game as a black box through the public harness surface: normal fixed
## physics frames, `harness_setup()` for starting arrangements, and the public
## snapshot/event stream. It does not call private dodge helpers or write game
## state during an assertion.
##
## The suite covers the requested feature, the invalid-state boundaries, both
## edges of the invulnerability window, cooldown, restart, HUD text, and the
## event stream. The existing Phase 16 suite remains the regression oracle for
## attack, deflect, posture, victory, defeat, and restart.

const PLAYER_SPAWN := Vector3(0.0, 0.02, 4.4)
const ENEMY_SPAWN := Vector3(0.0, 0.02, 0.8)

var passed := 0
var failed := 0
var cases: Array = []
var trace: Dictionary = {}


func _initialize() -> void:
	_run()


func _run() -> void:
	var world = load("res://main.tscn").instantiate()
	root.add_child(world)
	var startup: Dictionary = await _advance(world, 3)
	_check("dodge-startup-state", (
		String(startup.get("dodge_phase", "missing")) == "idle"
		and int(startup.get("dodge_tick", -1)) == 0
		and int(startup.get("dodge_cooldown", -1)) == 0
		and not bool(startup.get("dodge_invulnerable", true))
		and bool(startup.get("dodge_available", false))
		and _direction_is_zero(startup.get("dodge_direction", []))
	), "phase=%s tick=%s cooldown=%s available=%s" % [
		str(startup.get("dodge_phase", "missing")),
		str(startup.get("dodge_tick", "missing")),
		str(startup.get("dodge_cooldown", "missing")),
		str(startup.get("dodge_available", "missing")),
	])
	trace["startup"] = startup

	await _test_dodge_motion_and_phases(world)
	await _test_cooldown(world)
	await _test_rejected_while_attacking_or_parrying(world)
	await _test_rejected_after_defeat(world)
	await _test_iframes_block_damage(world)
	await _test_startup_is_vulnerable(world)
	await _test_late_active_is_vulnerable(world)
	await _test_restart_clears_dodge(world)
	await _test_dodge_does_not_cancel_attack_input(world)

	print("RESULT passed=%d failed=%d" % [passed, failed])
	print("PHASE17_DODGE_RESULT %d passed, %d failed, %d total" % [
		passed,
		failed,
		passed + failed,
	])
	print("PHASE17_DODGE_CASES %s" % JSON.stringify(cases))
	print("PHASE17_DODGE_TRACE %s" % JSON.stringify(trace))
	if failed > 0:
		quit(1)
	else:
		quit(0)


func _test_dodge_motion_and_phases(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 4.4],
		"enemy_position": [0.0, 0.02, -9.0],
	})
	var before: Dictionary = await _advance(world, 2)
	var started: Dictionary = await _advance(world, 1, {"strafe": 1.0, "dodge": true})
	var active_ticks := 1
	var saw_invulnerable := bool(started.get("dodge_invulnerable", false))
	var saw_vulnerable_early := not saw_invulnerable
	var snap: Dictionary = started
	for _index in range(30):
		if String(snap.get("dodge_phase", "missing")) != "active":
			break
		if bool(snap.get("dodge_invulnerable", false)):
			saw_invulnerable = true
		snap = await _advance(world, 1)
		active_ticks += 1

	var recovery_ticks := 0
	snap = started
	while String(snap.get("dodge_phase", "missing")) == "active":
		snap = await _advance(world, 1)
	# The loop above has advanced into recovery. Count the recovery frames.
	while String(snap.get("dodge_phase", "missing")) == "recovery" and recovery_ticks < 20:
		recovery_ticks += 1
		snap = await _advance(world, 1)

	var dx := float(snap["player_position"][0]) - float(before["player_position"][0])
	var dz := float(snap["player_position"][2]) - float(before["player_position"][2])
	var direction: Array = started.get("dodge_direction", [])
	var direction_x := float(direction[0]) if direction.size() >= 3 else 0.0
	var ok: bool = (
		String(started.get("dodge_phase", "missing")) == "active"
		and int(started.get("dodge_tick", 0)) >= 0
		and int(started.get("dodge_cooldown", 0)) >= 44
		and int(started.get("dodge_cooldown", 0)) <= 45
		and not bool(started.get("dodge_available", true))
		and saw_vulnerable_early
		and saw_invulnerable
		and active_ticks >= 17
		and active_ticks <= 19
		and recovery_ticks >= 9
		and recovery_ticks <= 11
		and String(snap.get("dodge_phase", "missing")) == "idle"
		and int(snap.get("dodge_tick", -1)) == 0
		and not bool(snap.get("dodge_invulnerable", true))
		and _direction_is_zero(snap.get("dodge_direction", []))
		and direction_x > 0.9
		and dx > 2.1
		and dx < 3.4
		and absf(dz) < 0.6
		and _count(world, "dodge_started") == 1
		and _count(world, "dodge_recovery") == 1
		and _count(world, "dodge_finished") == 1
	)
	trace["motion"] = {
		"started": started,
		"finished": snap,
		"active_ticks": active_ticks,
		"recovery_ticks": recovery_ticks,
		"dx": dx,
		"dz": dz,
	}
	_check("dodge-active-motion-and-phases", ok, (
		"active=%d recovery=%d dx=%.2f dz=%.2f phase=%s started=%d recovery_events=%d finished=%d"
	) % [
		active_ticks,
		recovery_ticks,
		dx,
		dz,
		str(snap.get("dodge_phase", "missing")),
		_count(world, "dodge_started"),
		_count(world, "dodge_recovery"),
		_count(world, "dodge_finished"),
	])
	var hud := String(snap.get("hud", ""))
	_check("dodge-hud-and-controls", (
		hud.find("DODGE") >= 0
		and hud.find("SPACE") >= 0
	), "hud_has_dodge=%s hud_has_space=%s" % [
		str(hud.find("DODGE") >= 0),
		str(hud.find("SPACE") >= 0),
	])


func _test_cooldown(world) -> void:
	var before_started := _count(world, "dodge_started")
	var before_rejected := _count(world, "dodge_rejected")
	var blocked: Dictionary = await _advance(world, 1, {"dodge": true})
	var reason := String(_first_event(world, "dodge_rejected").get("reason", ""))
	var blocked_ok: bool = (
		String(blocked.get("dodge_phase", "missing")) == "idle"
		and _count(world, "dodge_started") == before_started
		and _count(world, "dodge_rejected") > before_rejected
		and reason.find("cooldown") >= 0
	)
	var cooldown_before := int(blocked.get("dodge_cooldown", 0))
	var snap: Dictionary = blocked
	for _index in range(70):
		if int(snap.get("dodge_cooldown", 1)) <= 0:
			break
		snap = await _advance(world, 1)
	var ready_ok: bool = (
		int(snap.get("dodge_cooldown", -1)) == 0
		and bool(snap.get("dodge_available", false))
	)
	var restarted: Dictionary = await _advance(world, 1, {"dodge": true})
	var expanded_ok: bool = (
		String(restarted.get("dodge_phase", "missing")) == "active"
		and _count(world, "dodge_started") == before_started + 1
	)
	trace["cooldown"] = {
		"blocked": blocked,
		"cooldown_before": cooldown_before,
		"ready": snap,
		"restarted": restarted,
	}
	_check("dodge-cooldown-blocks-and-expires", (
		blocked_ok and ready_ok and expanded_ok
	), "blocked=%s cooldown=%d ready=%s restarted=%s starts=%d" % [
		str(blocked_ok),
		cooldown_before,
		str(ready_ok),
		str(expanded_ok),
		_count(world, "dodge_started"),
	])


func _test_rejected_while_attacking_or_parrying(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 4.4],
		"enemy_position": [0.0, 0.02, -9.0],
	})
	await _advance(world, 1, {"attack": true})
	var attack_snap: Dictionary = await _advance(world, 1, {"dodge": true})
	var attack_reason := ""
	for event in world.harness_events(0):
		if String(event.get("type", "")) == "dodge_rejected":
			attack_reason = String(event.get("reason", ""))
	var attack_ok: bool = (
		String(attack_snap.get("dodge_phase", "missing")) == "idle"
		and String(attack_snap.get("player_attack_phase", "missing")) != "idle"
		and _count(world, "dodge_started") == 0
		and attack_reason.find("attack") >= 0
	)

	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 4.4],
		"enemy_position": [0.0, 0.02, -9.0],
	})
	await _advance(world, 1, {"parry": true})
	var parry_snap: Dictionary = await _advance(world, 1, {"dodge": true})
	var parry_reason := ""
	for event in world.harness_events(0):
		if String(event.get("type", "")) == "dodge_rejected":
			parry_reason = String(event.get("reason", ""))
	var parry_ok: bool = (
		String(parry_snap.get("dodge_phase", "missing")) == "idle"
		and int(parry_snap.get("parry_ticks", 0)) > 0
		and _count(world, "dodge_started") == 0
		and parry_reason.find("parry") >= 0
	)
	trace["rejected_actions"] = {
		"attack": attack_snap,
		"attack_reason": attack_reason,
		"parry": parry_snap,
		"parry_reason": parry_reason,
	}
	_check("dodge-rejected-while-attacking", attack_ok, "phase=%s attack=%s reason=%s" % [
		str(attack_snap.get("dodge_phase", "missing")),
		str(attack_snap.get("player_attack_phase", "missing")),
		attack_reason,
	])
	_check("dodge-rejected-while-parrying", parry_ok, "phase=%s parry_ticks=%d reason=%s" % [
		str(parry_snap.get("dodge_phase", "missing")),
		int(parry_snap.get("parry_ticks", 0)),
		parry_reason,
	])


func _test_rejected_after_defeat(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
		"player_health": 1,
	})
	var snap: Dictionary = await _advance(world, 2)
	for _index in range(120):
		if String(snap.get("outcome", "")) == "defeat":
			break
		snap = await _advance(world, 1)
	var started_before := _count(world, "dodge_started")
	var rejected_before := _count(world, "dodge_rejected")
	var after: Dictionary = await _advance(world, 1, {"dodge": true})
	var ok: bool = (
		String(snap.get("outcome", "")) == "defeat"
		and String(after.get("dodge_phase", "missing")) == "idle"
		and _count(world, "dodge_started") == started_before
		and _count(world, "dodge_rejected") > rejected_before
	)
	trace["defeat"] = {"defeat": snap, "after": after}
	_check("dodge-rejected-after-defeat", ok, "outcome=%s phase=%s starts=%d rejected=%d" % [
		str(after.get("outcome", "missing")),
		str(after.get("dodge_phase", "missing")),
		_count(world, "dodge_started"),
		_count(world, "dodge_rejected"),
	])


func _test_iframes_block_damage(world) -> void:
	var snap: Dictionary = await _prepare_windup(world, 27)
	var started: Dictionary = await _advance(world, 1, {"forward": 1.0, "dodge": true})
	var after: Dictionary = await _advance(world, 3)
	var ok: bool = (
		String(started.get("dodge_phase", "missing")) == "active"
		and bool(after.get("dodge_invulnerable", false))
		and int(after.get("player_health", 0)) == 4
		and _count(world, "dodge_evaded") >= 1
		and _count(world, "enemy_hit_player") == 0
		and _count(world, "parry_success") == 0
	)
	trace["iframe_block"] = {"windup": snap, "started": started, "after": after}
	_check("dodge-iframe-blocks-enemy-damage", ok, "phase=%s tick=%d invuln=%s health=%d evaded=%d hits=%d" % [
		str(after.get("dodge_phase", "missing")),
		int(after.get("dodge_tick", -1)),
		str(after.get("dodge_invulnerable", "missing")),
		int(after.get("player_health", -1)),
		_count(world, "dodge_evaded"),
		_count(world, "enemy_hit_player"),
	])


func _test_startup_is_vulnerable(world) -> void:
	var snap: Dictionary = await _prepare_windup(world, 29)
	var started: Dictionary = await _advance(world, 1, {"forward": 1.0, "dodge": true})
	var after: Dictionary = await _advance(world, 1)
	var ok: bool = (
		String(started.get("dodge_phase", "missing")) == "active"
		and not bool(started.get("dodge_invulnerable", true))
		and not bool(after.get("dodge_invulnerable", true))
		and int(after.get("player_health", 0)) == 3
		and _count(world, "enemy_hit_player") == 1
		and _count(world, "dodge_evaded") == 0
	)
	trace["startup_vulnerable"] = {"windup": snap, "started": started, "after": after}
	_check("dodge-startup-is-vulnerable", ok, "phase=%s tick=%d invuln=%s health=%d hits=%d evaded=%d" % [
		str(after.get("dodge_phase", "missing")),
		int(after.get("dodge_tick", -1)),
		str(after.get("dodge_invulnerable", "missing")),
		int(after.get("player_health", -1)),
		_count(world, "enemy_hit_player"),
		_count(world, "dodge_evaded"),
	])


func _test_late_active_is_vulnerable(world) -> void:
	var snap: Dictionary = await _prepare_windup(world, 15)
	var started: Dictionary = await _advance(world, 1, {"forward": 1.0, "dodge": true})
	var after: Dictionary = await _advance(world, 15)
	var ok: bool = (
		String(started.get("dodge_phase", "missing")) == "active"
		and String(after.get("dodge_phase", "missing")) == "active"
		and not bool(after.get("dodge_invulnerable", true))
		and int(after.get("player_health", 0)) == 3
		and _count(world, "enemy_hit_player") == 1
		and _count(world, "dodge_evaded") == 0
	)
	trace["late_vulnerable"] = {"windup": snap, "started": started, "after": after}
	_check("dodge-late-active-is-vulnerable", ok, "phase=%s tick=%d invuln=%s health=%d hits=%d evaded=%d" % [
		str(after.get("dodge_phase", "missing")),
		int(after.get("dodge_tick", -1)),
		str(after.get("dodge_invulnerable", "missing")),
		int(after.get("player_health", -1)),
		_count(world, "enemy_hit_player"),
		_count(world, "dodge_evaded"),
	])


func _test_restart_clears_dodge(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 4.4],
		"enemy_position": [0.0, 0.02, -9.0],
	})
	await _advance(world, 1, {"dodge": true})
	await _advance(world, 3)
	var reset: Dictionary = await _advance(world, 1, {"restart": true})
	var reset_ok: bool = (
		int(reset.get("step", -1)) == 0
		and String(reset.get("dodge_phase", "missing")) == "idle"
		and int(reset.get("dodge_tick", -1)) == 0
		and int(reset.get("dodge_cooldown", -1)) == 0
		and not bool(reset.get("dodge_invulnerable", true))
		and _direction_is_zero(reset.get("dodge_direction", []))
		and int(reset.get("player_health", 0)) == 4
		and String(reset.get("last_event_type", "")) == "reset"
	)
	var restarted: Dictionary = await _advance(world, 1, {"dodge": true})
	var restart_usable: bool = String(restarted.get("dodge_phase", "missing")) == "active"
	trace["restart"] = {"reset": reset, "restarted": restarted}
	_check("dodge-restart-clears-and-rearms", (
		reset_ok and restart_usable
	), "step=%d phase=%s cooldown=%d reset_event=%s rearmed=%s" % [
		int(reset.get("step", -1)),
		str(reset.get("dodge_phase", "missing")),
		int(reset.get("dodge_cooldown", -1)),
		str(reset.get("last_event_type", "")),
		str(restart_usable),
	])


func _test_dodge_does_not_cancel_attack_input(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 4.4],
		"enemy_position": [0.0, 0.02, -9.0],
	})
	await _advance(world, 1, {"dodge": true})
	var during: Dictionary = await _advance(world, 1, {"attack": true})
	var blocked_ok: bool = (
		String(during.get("dodge_phase", "missing")) == "active"
		and String(during.get("player_attack_phase", "missing")) == "idle"
		and _count(world, "attack_started") == 0
	)
	for _index in range(40):
		if String(during.get("dodge_phase", "missing")) == "idle":
			break
		during = await _advance(world, 1)
	var ready: Dictionary = await _advance(world, 1, {"attack": true})
	var attack_ok: bool = (
		String(during.get("dodge_phase", "missing")) == "idle"
		and String(ready.get("player_attack_phase", "missing")) != "idle"
		and _count(world, "attack_started") == 1
	)
	trace["attack_during_dodge"] = {"during": during, "ready": ready}
	_check("dodge-does-not-cancel-attack-input", (
		blocked_ok and attack_ok
	), "during_phase=%s during_attack=%s ready_attack=%s starts=%d" % [
		str(during.get("dodge_phase", "missing")),
		str(during.get("player_attack_phase", "missing")),
		str(ready.get("player_attack_phase", "missing")),
		_count(world, "attack_started"),
	])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

func _prepare_windup(world, target_tick: int) -> Dictionary:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
		"player_health": 4,
	})
	var snap: Dictionary = await _advance(world, 2)
	for _index in range(120):
		if String(snap.get("enemy_phase", "")) == "windup":
			break
		snap = await _advance(world, 1)
	for _index in range(40):
		if String(snap.get("enemy_phase", "")) != "windup":
			break
		if int(snap.get("enemy_phase_tick", 0)) >= target_tick:
			break
		snap = await _advance(world, 1)
	return snap


func _advance(world, frames: int, input: Dictionary = {}) -> Dictionary:
	var values := {
		"forward": 0.0,
		"strafe": 0.0,
		"attack": false,
		"parry": false,
		"restart": false,
		"dodge": false,
	}
	for key in input:
		values[key] = input[key]
	world.set_harness_input(values)
	for _index in range(frames):
		await physics_frame
	await process_frame
	return world.snapshot()


func _first_event(world, event_type: String) -> Dictionary:
	for event in world.harness_events(0):
		if String(event.get("type", "")) == event_type:
			return event
	return {}


func _count(world, event_type: String) -> int:
	var total := 0
	for event in world.harness_events(0):
		if String(event.get("type", "")) == event_type:
			total += 1
	return total


func _direction_is_zero(value) -> bool:
	if not value is Array or value.size() < 3:
		return false
	return absf(float(value[0])) < 0.001 and absf(float(value[1])) < 0.001 and absf(float(value[2])) < 0.001


func _check(name: String, condition: bool, detail: String) -> void:
	var ok: bool = bool(condition)
	if ok:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	cases.append({"name": name, "ok": ok, "detail": detail})
