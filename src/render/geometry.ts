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
  geometry.computeBoundingSphere()
  return geometry
}
