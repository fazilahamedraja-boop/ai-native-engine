import * as THREE from 'three'
import type { MeshData } from '../assets/types'

/**
 * MeshData -> THREE. The single crossing point between the asset layer and the
 * renderer, which is why the asset layer never imports THREE.
 */
export function bufferGeometryFrom(mesh: MeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3))
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1))

  if (mesh.colors !== undefined) {
    // Asset colours are authored in sRGB; THREE multiplies vertex colours in
    // linear working space, so convert here rather than in every generator.
    const linear = new Float32Array(mesh.colors.length)
    const scratch = new THREE.Color()
    for (let i = 0; i < mesh.colors.length; i += 3) {
      scratch.setRGB(mesh.colors[i], mesh.colors[i + 1], mesh.colors[i + 2], THREE.SRGBColorSpace)
      linear[i] = scratch.r
      linear[i + 1] = scratch.g
      linear[i + 2] = scratch.b
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(linear, 3))
  }

  geometry.computeBoundingSphere()
  return geometry
}
