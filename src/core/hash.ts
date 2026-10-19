const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a over quantized floats.
 *
 * Quantizing to 1e-6 keeps the hash stable against float noise nobody can see,
 * while still catching real drift. If two runs disagree here, something in the
 * simulation is genuinely non-deterministic and every screenshot is suspect.
 */
export function hashNumbers(values: readonly number[], seed = FNV_OFFSET): string {
  let h = seed >>> 0
  for (const value of values) {
    const q = Math.round(value * 1e6) | 0
    for (let shift = 0; shift < 32; shift += 8) {
      h ^= (q >>> shift) & 0xff
      h = Math.imul(h, FNV_PRIME) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 64-bit variant for values that get persisted, such as an asset artifact hash
 * in the index. Two FNV passes with different seeds. Not cryptographic; the
 * extra width is only there to make an accidental match across asset versions
 * implausible.
 */
export function hashNumbers64(values: readonly number[]): string {
  return hashNumbers(values, FNV_OFFSET) + hashNumbers(values, 0x9e3779b9)
}
