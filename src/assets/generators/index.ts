/**
 * Generator registration. Importing this module is what makes a kind buildable;
 * a manifest for an unregistered kind fails with `unknown_generator` instead of
 * silently producing nothing.
 */
import { registerGenerator } from '../registry'
import { pineGenerator } from './pine'
import { rockGenerator } from './rock'
import { swordGenerator } from './sword'

registerGenerator(swordGenerator)
registerGenerator(rockGenerator)
registerGenerator(pineGenerator)
