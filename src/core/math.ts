/**
 * Small, dependency-free math used by the World layer.
 *
 * Deliberately not THREE: SceneDoc and World must stay renderer-agnostic so the
 * agent contract never changes when the renderer does. Matrices are
 * column-major, matching THREE.Matrix4.fromArray so the renderer can consume
 * them without conversion.
 */

export type Vec3 = [number, number, number]
export type Mat4 = number[]

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z]

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2])
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export const DEG2RAD = Math.PI / 180

/**
 * R = Rx(x) * Ry(y) * Rz(z), the same order THREE.Euler uses for "XYZ".
 * Rotation values arrive in degrees because a document is authored by an agent,
 * and 90 is less error-prone to write than 1.5707963267948966.
 */
export function composeMatrix(pos: Vec3, rotDeg: Vec3, scl: Vec3): Mat4 {
  const [ax, ay, az] = [rotDeg[0] * DEG2RAD, rotDeg[1] * DEG2RAD, rotDeg[2] * DEG2RAD]
  const ca = Math.cos(ax), sa = Math.sin(ax)
  const cb = Math.cos(ay), sb = Math.sin(ay)
  const cc = Math.cos(az), sc = Math.sin(az)

  const m: Mat4 = new Array<number>(16).fill(0)
  m[0] = cb * cc * scl[0]
  m[1] = (ca * sc + sa * sb * cc) * scl[0]
  m[2] = (sa * sc - ca * sb * cc) * scl[0]
  m[4] = -cb * sc * scl[1]
  m[5] = (ca * cc - sa * sb * sc) * scl[1]
  m[6] = (sa * cc + ca * sb * sc) * scl[1]
  m[8] = sb * scl[2]
  m[9] = -sa * cb * scl[2]
  m[10] = ca * cb * scl[2]
  m[12] = pos[0]
  m[13] = pos[1]
  m[14] = pos[2]
  m[15] = 1
  return m
}

export function identity(): Mat4 {
  const m: Mat4 = new Array<number>(16).fill(0)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** C = A * B, column-major. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array<number>(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[col * 4 + k]
      }
      out[col * 4 + row] = sum
    }
  }
  return out
}

export function transformPoint(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ]
}

/** Translation column of a matrix. */
export function translationOf(m: Mat4): Vec3 {
  return [m[12], m[13], m[14]]
}

/**
 * Lengths of the three basis vectors — the effective world scale.
 * Rounded because a pure rotation otherwise reports 0.9999999999999999, which
 * is noise an agent would keep re-diffing.
 */
export function basisScaleOf(m: Mat4): Vec3 {
  const round = (v: number): number => Math.round(v * 1e6) / 1e6
  return [
    round(Math.hypot(m[0], m[1], m[2])),
    round(Math.hypot(m[4], m[5], m[6])),
    round(Math.hypot(m[8], m[9], m[10])),
  ]
}
