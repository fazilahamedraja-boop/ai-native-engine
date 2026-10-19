/**
 * sfc32 — small, fast, seedable, and stable forever.
 *
 * This is the only source of randomness in the asset pipeline. Generators must
 * not call Math.random, Date.now, or iterate an unordered Map keyed by strings,
 * because an artifact has to be a pure function of (params, seed, version).
 * Bump RNG_VERSION only if the algorithm changes; that invalidates every seed.
 */
export const RNG_VERSION = 1

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number
  /** Uniform in [min, max). */
  range(min: number, max: number): number
  pick<T>(items: readonly [T, ...T[]]): T
  /** True with probability p. */
  chance(p: number): boolean
}

/** splitmix32, used only to expand one integer seed into four state words. */
function seedWords(seed: number): [number, number, number, number] {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
    return (z ^ (z >>> 15)) >>> 0
  }
  return [next(), next(), next(), next()]
}

export function createRng(seed: number): Rng {
  let [a, b, c, d] = seedWords(seed)

  const next = (): number => {
    a >>>= 0
    b >>>= 0
    c >>>= 0
    d >>>= 0
    let t = (a + b) >>> 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) >>> 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) >>> 0
    t = (t + d) >>> 0
    c = (c + t) >>> 0
    return (t >>> 0) / 4294967296
  }

  // Discard the first few outputs: sfc32 warms up slowly from a shared seed.
  for (let i = 0; i < 12; i++) next()

  return {
    next,
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error(`rng.int needs a positive integer bound, got ${maxExclusive}`)
      }
      return Math.floor(next() * maxExclusive)
    },
    range(min, max) {
      return min + next() * (max - min)
    },
    pick(items) {
      return items[Math.floor(next() * items.length)]
    },
    chance(p) {
      return next() < p
    },
  }
}
