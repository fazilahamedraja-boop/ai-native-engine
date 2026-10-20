import type { GameAsset, GameConfig, GameVisual } from './types'

/**
 * Converts the text game block into render-only instances. Missing assets are
 * skipped here; CollectGame reports them as errors and the HUD shows the list.
 */
export function buildGameVisuals(config: GameConfig, assets: ReadonlyMap<string, GameAsset>): GameVisual[] {
  const visuals: GameVisual[] = []

  for (const prop of config.props) {
    const asset = assets.get(prop.asset)
    if (asset === undefined) continue
    visuals.push({
      id: prop.id,
      mesh: asset.artifact.geometry,
      material: asset.material,
      pos: prop.pos,
      rotY: prop.rotY,
      scale: prop.scale,
      kind: 'prop',
    })
  }

  for (const item of config.collectibles) {
    const asset = assets.get(item.asset)
    if (asset === undefined) continue
    visuals.push({
      id: item.id,
      mesh: asset.artifact.geometry,
      material: asset.material,
      pos: item.pos,
      rotY: item.rotY,
      scale: item.scale,
      kind: 'collectible',
    })
  }

  for (const enemy of config.enemies) {
    const asset = assets.get(enemy.asset)
    if (asset === undefined) continue
    visuals.push({
      id: enemy.id,
      mesh: asset.artifact.geometry,
      material: asset.material,
      pos: enemy.pos,
      rotY: enemy.rotY,
      scale: enemy.scale,
      kind: 'enemy',
    })
  }

  return visuals
}
