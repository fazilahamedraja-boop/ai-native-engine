import fs from 'node:fs'
import path from 'node:path'

export const CLEAN_DIRECTION = 'var direction := Vector3(strafe, 0.0, -forward)'
export const DEFECT_DIRECTION = 'var direction := Vector3(strafe, 0.0, forward)'

export function injectDefect(projectDir) {
  const file = path.join(projectDir, 'scripts', 'player.gd')
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes(CLEAN_DIRECTION)) {
    throw new Error(`Clean movement line not found in ${file}`)
  }
  if (source.includes(DEFECT_DIRECTION)) {
    throw new Error(`Defect is already present in ${file}`)
  }
  fs.writeFileSync(file, source.replace(CLEAN_DIRECTION, DEFECT_DIRECTION))
}

export function repairDefect(projectDir) {
  const file = path.join(projectDir, 'scripts', 'player.gd')
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes(DEFECT_DIRECTION)) {
    throw new Error(`Defect movement line not found in ${file}`)
  }
  fs.writeFileSync(file, source.replace(DEFECT_DIRECTION, CLEAN_DIRECTION))
}
