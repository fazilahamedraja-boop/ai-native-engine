import { CHUNK_BIN, CHUNK_JSON, GLB_MAGIC, GLB_VERSION } from '../import/glb'

export { CHUNK_BIN, CHUNK_JSON }

/** Shared GLB writer for the indexer and decoder suites. */
export const JSON_PAD = 0x20
export const BIN_PAD = 0x00

export interface Chunk {
  type: number
  data: Uint8Array
}

export function pad4(bytes: Uint8Array, pad: number): Uint8Array {
  const padding = (4 - (bytes.length % 4)) % 4
  const out = new Uint8Array(bytes.length + padding)
  out.set(bytes)
  out.fill(pad, bytes.length)
  return out
}

/** Minimal GLB writer: enough to produce valid and deliberately broken files. */
export function container(chunks: readonly Chunk[]): Uint8Array {
  const total = 12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.data.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, GLB_MAGIC, true)
  view.setUint32(4, GLB_VERSION, true)
  view.setUint32(8, total, true)

  let offset = 12
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.data.length, true)
    view.setUint32(offset + 4, chunk.type, true)
    out.set(chunk.data, offset + 8)
    offset += 8 + chunk.data.length
  }
  return out
}

export function jsonChunk(doc: unknown): Chunk {
  return { type: CHUNK_JSON, data: pad4(new TextEncoder().encode(JSON.stringify(doc)), JSON_PAD) }
}

export function glb(doc: unknown, bin?: Uint8Array): Uint8Array {
  const chunks: Chunk[] = [jsonChunk(doc)]
  if (bin !== undefined) chunks.push({ type: CHUNK_BIN, data: pad4(bin, BIN_PAD) })
  return container(chunks)
}

export function patched(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice()
  new DataView(copy.buffer).setUint32(offset, value, true)
  return copy
}
