/**
 * Generate the desktop app icon without an image dependency.
 *
 *   node desktop/make-icon.mjs
 *
 * Produces desktop/icon.png (256 px, used by the window) and desktop/icon.ico
 * (multi-size PNG-compressed ICO, used by the Windows shell and packager).
 * The drawing is a rounded dark tile with an amber hexagon "gem" and cube
 * spokes, matching the brand mark in desktop.html.
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const half = size / 2
  const samples = size >= 64 ? 4 : 8
  const tileHalf = size / 2 - size * 0.02
  const tileRadius = size * 0.22
  const gemRadius = size * 0.3
  const ring = size * 0.042
  const spoke = size * 0.016
  const spokes = [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3]

  function roundedTile(x, y) {
    const qx = Math.abs(x - half) - (tileHalf - tileRadius)
    const qy = Math.abs(y - half) - (tileHalf - tileRadius)
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0))
    return outside + Math.min(Math.max(qx, qy), 0) - tileRadius
  }

  function hexDistance(x, y) {
    const px = x - half
    const py = y - half
    let best = -Infinity
    for (let index = 0; index < 6; index += 1) {
      const angle = (index * Math.PI) / 3
      const distance = px * Math.cos(angle) + py * Math.sin(angle)
      if (distance > best) best = distance
    }
    return best - gemRadius * Math.cos(Math.PI / 6)
  }

  function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared
    t = Math.max(0, Math.min(1, t))
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples
          const py = y + (sy + 0.5) / samples
          if (roundedTile(px, py) > 0) continue

          // Tile background with a subtle vertical lift.
          const t = py / size
          let r = Math.round(13 + 6 * t)
          let g = Math.round(16 + 7 * t)
          let b = Math.round(23 + 10 * t)

          const hex = hexDistance(px, py)
          const inner = Math.abs(hex) < size * 0.055
          const outline = Math.abs(hex) < ring / 2
          let inSpoke = false
          for (const angle of spokes) {
            const ex = half + Math.cos(angle) * gemRadius * 0.78
            const ey = half + Math.sin(angle) * gemRadius * 0.78
            if (distanceToSegment(px, py, half, half, ex, ey) < spoke / 2) inSpoke = true
          }

          if (outline || inSpoke) {
            r = Math.round(233 - 20 * t)
            g = Math.round(177 - 26 * t)
            b = Math.round(100 - 30 * t)
          } else if (hex < 0) {
            r = Math.round(r + (224 - r) * 0.16)
            g = Math.round(g + (164 - g) * 0.16)
            b = Math.round(b + (88 - b) * 0.16)
          }
          if (inner) {
            r = 245
            g = 199
            b = 128
          }

          red += r
          green += g
          blue += b
          alpha += 255
        }
      }
      const total = samples * samples
      const offset = (y * size + x) * 4
      rgba[offset] = Math.round(red / total)
      rgba[offset + 1] = Math.round(green / total)
      rgba[offset + 2] = Math.round(blue / total)
      rgba[offset + 3] = Math.round(alpha / total)
    }
  }
  return rgba
}

function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  entries.forEach((entry, index) => {
    const base = index * 16
    directory[base] = entry.size >= 256 ? 0 : entry.size
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size
    directory[base + 2] = 0
    directory[base + 3] = 0
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

const sizes = [256, 64, 48, 32, 16]
const entries = sizes.map((size) => ({ size, png: encodePng(size, render(size)) }))

const pngPath = path.join(HERE, 'icon.png')
const icoPath = path.join(HERE, 'icon.ico')
fs.writeFileSync(pngPath, entries[0].png)
fs.writeFileSync(icoPath, encodeIco(entries))
console.log(`wrote ${pngPath} (${entries[0].png.length} bytes)`)
console.log(`wrote ${icoPath} (${fs.statSync(icoPath).size} bytes, sizes ${sizes.join(', ')})`)
