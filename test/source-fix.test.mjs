import assert from 'node:assert/strict'
import { safeReplacementSource } from '../lib/index.js'

const compact = {
  source: {
    kind: 'compact-checkpoint',
    compactionId: 'f58d537f-1f73-43ef-bd68-50db817b5f09',
    sourceCommandId: 'cmd-a9d30df4-1'
  }
}
const fixed = safeReplacementSource(compact)
assert.deepEqual(fixed, { kind: 'plugin:context-fold' })
assert.equal(fixed.compactionId, undefined)
assert.equal(fixed.sourceCommandId, undefined)

const normal = { source: { kind: 'plugin:context-fold' } }
assert.deepEqual(safeReplacementSource(normal), { kind: 'plugin:context-fold' })

assert.equal(safeReplacementSource({}), undefined)
assert.equal(safeReplacementSource(null), undefined)

console.log('safeReplacementSource: OK')
