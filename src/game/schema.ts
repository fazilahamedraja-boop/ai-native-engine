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
})

export type GameConfig = z.infer<typeof GameConfigSchema>
