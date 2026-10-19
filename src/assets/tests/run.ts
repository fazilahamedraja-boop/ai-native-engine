import { printSuite } from '../../devtools/node-tests'
import { suite as contractSuite } from './contract.test'
import { suite as swordSuite } from './sword.test'

export function main(): number {
  const suites = [contractSuite(), swordSuite()]
  suites.forEach((suite, index) => {
    if (index > 0) console.log('')
    printSuite(suite)
  })
  return suites.every((suite) => suite.passed) ? 0 : 1
}
