const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a over quantized floats.
 *
 * Quantizing to 1e-6 keeps the hash stable against float noise nobody can see,
 * while still catching real drift. If two runs disagree here, something in the
 * simulation is genuinely non-deterministic and every screenshot is suspect.
 */
export function hashNumbers(values: readonly number[]): string {
  let h = FNV_OFFSET
  for (const value of values) {
    const q = Math.round(value * 1e6) | 0
    for (let shift = 0; shift < 32; shift += 8) {
      h ^= (q >>> shift) & 0xff
      h = Math.imul(h, FNV_PRIME) >>> 0
    }
  }
  return h.toString(16).padStart(8, '0')
}
