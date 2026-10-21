import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')

function readGlb(file) {
  const buffer = fs.readFileSync(file)
  const magic = buffer.readUInt32LE(0)
  const version = buffer.readUInt32LE(4)
  const length = buffer.readUInt32LE(8)
  if (magic !== 0x46546c67) throw new Error(`Not a GLB: ${file}`)
  let document = null
  let offset = 12
  while (offset < length) {
    const chunkLength = buffer.readUInt32LE(offset)
    const chunkType = buffer.readUInt32LE(offset + 4)
    const chunk = buffer.subarray(offset + 8, offset + 8 + chunkLength)
    if (chunkType === 0x4e4f534a) {
      document = JSON.parse(chunk.toString('utf8').replace(/\0+$/g, '').trimEnd())
    }
    offset += 8 + chunkLength
  }
  if (document == null) throw new Error(`No JSON chunk: ${file}`)
  return { buffer, document }
}

function summarize(absolutePath, relativePath, source = 'project') {
  const { buffer, document } = readGlb(absolutePath)
  const nodes = document.nodes ?? []
  const skins = document.skins ?? []
  const animations = document.animations ?? []
  return {
    path: relativePath,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    source,
    generator: document.asset?.generator ?? null,
    version: document.asset?.version ?? null,
    counts: {
      nodes: nodes.length,
      meshes: (document.meshes ?? []).length,
      skins: skins.length,
      animations: animations.length,
    },
    node_names: nodes.map((node) => node.name ?? null),
    skins: skins.map((skin, index) => ({
      index,
      name: skin.name ?? null,
      joint_count: (skin.joints ?? []).length,
      joint_names: (skin.joints ?? []).map((joint) => nodes[joint]?.name ?? null),
      skeleton_node: skin.skeleton ?? null,
    })),
    animations: animations.map((animation, index) => ({
      index,
      name: animation.name ?? null,
      channel_count: (animation.channels ?? []).length,
      sampler_count: (animation.samplers ?? []).length,
      targets: [...new Set((animation.channels ?? []).map((channel) => {
        const target = channel.target ?? {}
        return `${nodes[target.node]?.name ?? target.node}:${target.path}`
      }))],
    })),
  }
}

const files = [
  ['content/assets/character/humanoid-01.glb', 'project-content'],
  ['content/assets/character/placeholder-character.glb', 'project-content'],
  ['experiments/godot-harness/fixtures/character-audit/assets/humanoid-01.glb', 'fixture-copy'],
  ['experiments/godot-harness/fixtures/character-audit/assets/CesiumMan.glb', 'test-only CC-BY-4.0 glTF sample'],
]

const report = {
  operation: 'phase11_glb_source_inventory',
  generated_at: new Date().toISOString(),
  note: 'Source glTF JSON chunk inspection; no skeleton or animation was synthesized.',
  assets: files.map(([relativePath, source]) => summarize(
    path.resolve(ROOT, relativePath),
    relativePath,
    source,
  )),
}
console.log(JSON.stringify(report, null, 2))
