import { z } from 'zod'

const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'id must be a lowercase slug matching ^[a-z][a-z0-9_-]*$')
const AssetId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'asset id must be a lowercase slug matching ^[a-z][a-z0-9_-]*$')
const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])

const Collectible = z.strictObject({
  id: Id,
  asset: AssetId,
  pos: Vec3,
  radius: z.number().positive().default(1.2),
  /** Degrees around Y, matching SceneDoc transforms. */
  rotY: z.number().default(0),
  scale: z.number().positive().default(1),
})

const Prop = z.strictObject({
  id: Id,
  asset: AssetId,
  pos: Vec3,
  rotY: z.number().default(0),
  scale: z.number().positive().default(1),
})

const Enemy = z.strictObject({
  id: Id,
  asset: AssetId,
  pos: Vec3,
  /** Horizontal centre-to-centre contact distance. Not a physics collider. */
  radius: z.number().positive().default(0.9),
  health: z.number().int().positive().default(3),
  damage: z.number().int().positive().default(1),
  /** Degrees around Y, matching SceneDoc transforms. */
  rotY: z.number().default(0),
  scale: z.number().positive().default(1),
})

const CombatConfig = z
  .strictObject({
    playerHealth: z.number().int().positive().default(3),
    attackRange: z.number().positive().default(2),
    attackDamage: z.number().int().positive().default(1),
    /** Fixed 60 Hz steps. A held key never attacks; see Combat.update(). */
    attackCooldownSteps: z.number().int().min(1).default(12),
    /** Also the spawn/reset grace: no contact damage for this many steps. */
    contactCooldownSteps: z.number().int().min(1).default(60),
    hitFlashSteps: z.number().int().min(0).default(8),
  })
  .prefault({})

const CollectReturn = z.strictObject({
  mode: z.literal('collect-return'),
  avatar: z.strictObject({
    asset: AssetId,
    /** Applied to the imported humanoid; the collision capsule is separate. */
    scale: z.number().positive().default(1),
  }),
  collectibles: z.array(Collectible).min(1),
  returnZone: z.strictObject({
    pos: Vec3,
    radius: z.number().positive().default(1.5),
  }),
  props: z.array(Prop).default([]),
  combat: CombatConfig,
  enemies: z.array(Enemy).default([]),
})

export const GameConfigSchema = CollectReturn.superRefine((game, ctx) => {
  const seen = new Set<string>()
  const check = (id: string, path: (string | number)[]): void => {
    if (seen.has(id)) {
      ctx.addIssue({ code: 'custom', path, message: `duplicate game id '${id}'` })
    }
    seen.add(id)
  }

  game.collectibles.forEach((item, index) => check(item.id, ['collectibles', index, 'id']))
  game.props.forEach((prop, index) => check(prop.id, ['props', index, 'id']))
  game.enemies.forEach((enemy, index) => check(enemy.id, ['enemies', index, 'id']))
})

export type GameConfig = z.infer<typeof GameConfigSchema>
export type CombatConfig = z.infer<typeof CombatConfig>
export type EnemyConfig = z.infer<typeof Enemy>
