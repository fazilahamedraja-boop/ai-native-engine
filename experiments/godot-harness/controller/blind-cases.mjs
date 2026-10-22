/**
 * The controlled defects used by the Phase 14 blind-diagnosis benchmark.
 *
 * Each case is a one-line change to an isolated copy of an existing fixture,
 * in a different subsystem, with a different evidence signature and a
 * different failing acceptance case. They are not variations of one operator
 * inversion:
 *
 *   plate-never-registers        a gameplay STATE TRANSITION that never happens
 *   crate-does-not-fall          a PHYSICS CONFIGURATION that leaves one body inert
 *   crate-contact-not-published  an EVENT/SIGNAL path that never reports a real contact
 *   door-does-not-swing          an INTERACTION response in a different scene and
 *                                 mechanic, where the state says "open" but the
 *                                 door never moved
 *
 * This file contains the answer key. A diagnosing agent must not open it.
 */

export const BLIND_CASES = {
  'plate-never-registers': {
    id: 'plate-never-registers',
    sourceFixture: 'observation',
    testScript: 'res://tests/run_observation.gd',
    defectClass: 'incorrect gameplay-state transition',
    summary:
      'The pressure plate never registers a press, so the gate never opens and the goal is never reached.',
    injection: {
      file: 'scripts/observation_world.gd',
      from: '\tif not is_instance_valid(player) or body != player or plate_pressed:',
      to: '\tif not is_instance_valid(player) or body == player or plate_pressed:',
      location: '_on_plate_body_entered',
    },
    scenario: {
      description:
        'stand still for three fixed ticks, then walk forward for eighty-five ticks onto the pressure plate',
      phases: [
        { frames: 3, input: { forward: 0 } },
        { frames: 85, input: { forward: 1 } },
      ],
    },
    targets: ['/root/Main', '/root/Main/Player', '/root/Main/Plate', '/root/Main/Gate'],
    properties: [
      'plate_pressed',
      'gate_open',
      'gate_collision_enabled',
      'beacon_state',
      'feedback',
      'prompt',
      'goal_reached',
    ],
    physicsQueries: [
      {
        name: 'plate_volume',
        description:
          'box covering the pressure plate volume at (0, 0.10, -1.1), the place the player is expected to stand',
        shape_type: 'box',
        transform: { origin: [0, 0.1, -1.1] },
        size: [1.8, 0.2, 2.2],
      },
    ],
    expectedFailingCases: [
      'observation-plate-opens-gate',
      'observation-gate-passable-after-plate',
    ],
    diagnosisKeywords: [
      'plate',
      'body_entered',
      'filter',
      'guard',
      'register',
      'inverted',
      'player',
    ],
  },

  'crate-does-not-fall': {
    id: 'crate-does-not-fall',
    sourceFixture: 'observation',
    testScript: 'res://tests/run_observation.gd',
    defectClass: 'incorrect physics configuration that leaves one body inert',
    summary:
      'The falling crate stays exactly at its spawn height: it is awake and stationary while the rest of the scene runs.',
    injection: {
      file: 'scripts/observation_world.gd',
      from: '\tcrate.gravity_scale = 1.0',
      to: '\tcrate.gravity_scale = 0.0',
      location: '_build_crate',
    },
    scenario: {
      description: 'stand still for three fixed ticks, then let the scene run for ninety fixed ticks',
      phases: [
        { frames: 3, input: { forward: 0 } },
        { frames: 90, input: { forward: 0 } },
      ],
    },
    targets: ['/root/Main', '/root/Main/Crate', '/root/Main/Ground'],
    properties: ['plate_pressed', 'gate_open', 'beacon_state', 'feedback', 'goal_reached'],
    physicsQueries: [
      {
        name: 'crate_spawn_height',
        description:
          'box at the crate spawn height (4.2, 3.00, 2.5), to find out whether the crate is still up there',
        shape_type: 'box',
        transform: { origin: [4.2, 3.0, 2.5] },
        size: [0.7, 0.7, 0.7],
      },
      {
        name: 'crate_resting_height',
        description:
          'box at the height where the crate would rest if it had fallen (4.2, 0.35, 2.5)',
        shape_type: 'box',
        transform: { origin: [4.2, 0.35, 2.5] },
        size: [0.7, 0.7, 0.7],
      },
    ],
    expectedFailingCases: ['observation-crate-falls'],
    diagnosisKeywords: [
      'gravity',
      'crate',
      'fall',
      'rigid',
      'physics',
      'spawn',
      'scale',
    ],
  },

  'crate-contact-not-published': {
    id: 'crate-contact-not-published',
    sourceFixture: 'observation',
    testScript: 'res://tests/run_observation.gd',
    defectClass: 'incorrect event and signal handling that suppresses a real contact',
    summary:
      'The crate falls and comes to rest on the ground exactly as it should, but the fixture never publishes the contact event for it.',
    injection: {
      file: 'scripts/observation_world.gd',
      from: '\tcrate.contact_monitor = true',
      to: '\tcrate.contact_monitor = false',
      location: '_build_crate',
    },
    scenario: {
      description: 'stand still for three fixed ticks, then let the scene run for ninety fixed ticks',
      phases: [
        { frames: 3, input: { forward: 0 } },
        { frames: 90, input: { forward: 0 } },
      ],
    },
    targets: ['/root/Main', '/root/Main/Crate', '/root/Main/Ground'],
    properties: ['plate_pressed', 'gate_open', 'beacon_state', 'feedback', 'goal_reached'],
    physicsQueries: [
      {
        name: 'crate_resting_height',
        description:
          'box at the height where the crate rests on the ground (4.2, 0.35, 2.5), to find out whether the crate is physically touching the ground',
        shape_type: 'box',
        transform: { origin: [4.2, 0.35, 2.5] },
        size: [0.7, 0.7, 0.7],
      },
    ],
    expectedFailingCases: ['observation-crate-falls'],
    diagnosisKeywords: [
      'contact',
      'event',
      'monitor',
      'signal',
      'publish',
      'crate_collision',
      'report',
    ],
  },

  'door-does-not-swing': {
    id: 'door-does-not-swing',
    sourceFixture: 'door',
    // The door fixture keeps its own smaller bridge. The observation bridge is
    // copied in so the generic observation and physics-query surface is
    // available, exactly as the Phase 10 door-reuse test does. The door scene
    // and scripts are untouched.
    bridgeSource: 'observation',
    testScript: 'res://tests/run_door.gd',
    defectClass:
      'incorrect interaction response in a different scene: the state says the door opened but the door never moved',
    summary:
      'Unlocking the door reports success and the collider is switched off, but the door panel never swings, so the doorway still looks closed.',
    injection: {
      file: 'scripts/door.gd',
      from: '\trotation.y = deg_to_rad(OPEN_ANGLE_DEGREES)',
      to: '\trotation.y = deg_to_rad(0.0)',
      location: '_open',
    },
    scenario: {
      description:
        'walk to the key, take it, walk to the door, unlock it, then walk through the doorway',
      phases: [
        { frames: 3, input: { forward: 0, strafe: 0 } },
        { frames: 30, input: { forward: 0, strafe: 1 } },
        { frames: 15, input: { forward: 1, strafe: 0 } },
        { frames: 30, input: { forward: 0, strafe: -1 } },
        { frames: 100, input: { forward: 1, strafe: 0 } },
        { frames: 1, input: { forward: 0, strafe: 0, actions: { interact: true } } },
        { frames: 60, input: { forward: 1, strafe: 0 } },
      ],
    },
    targets: ['/root/Main', '/root/Main/Door', '/root/Main/Player', '/root/Main/Key'],
    properties: [
      'door_locked',
      'door_open',
      'door_collision_enabled',
      'door_rotation_degrees',
      'player_has_key',
      'key_available',
      'feedback',
      'prompt',
    ],
    physicsQueries: [
      {
        name: 'doorway_volume',
        description:
          'box covering the doorway (0, 1.10, 0), to find out whether a door collider is still in the opening',
        shape_type: 'box',
        transform: { origin: [0, 1.1, 0] },
        size: [1.6, 2.2, 0.4],
      },
    ],
    expectedFailingCases: ['door-unlock-open-pass'],
    diagnosisKeywords: [
      'rotation',
      'swing',
      'open',
      'transform',
      'panel',
      'door',
      'rotate',
      'angle',
    ],
  },
}

export const BLIND_CASE_IDS = Object.keys(BLIND_CASES)
