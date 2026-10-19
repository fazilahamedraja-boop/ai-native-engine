import type { Vec3 } from '../core/math'

/**
 * Camera directions for the asset inspector. Kept THREE-free so the Node CLI
 * can validate a `--view` argument without pulling the renderer in.
 */
export const VIEWS = ['three-quarter', 'front', 'side', 'top'] as const
export type ViewName = (typeof VIEWS)[number]

export const VIEW_DIRECTIONS: Record<ViewName, Vec3> = {
  'three-quarter': [0.75, 0.45, 1],
  front: [0, 0, 1],
  side: [1, 0, 0],
  top: [0, 1, 0],
}

export function isViewName(value: string): value is ViewName {
  return (VIEWS as readonly string[]).includes(value)
}
