import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareSurfaceOpVersions,
  replaceSurfaceOp,
  SURFACE_OP_RENAME_VERSION,
  usesNewSurfaceOpShape,
} from '../src/surface-op.ts'

test('surface-op: versions below 0.1.5-alpha.1 speak the legacy {start,end} shape', () => {
  for (const v of ['0.1.0-rc.6', '0.1.1-rc.2', '0.1.2-alpha.4', '0.1.2-rc.1', '0.1.3-alpha.2']) {
    assert.equal(usesNewSurfaceOpShape(v), false, `${v} is legacy`)
    assert.deepEqual(replaceSurfaceOp(3, 7, v), { op: 'replace', start: 3, end: 7 })
  }
})

test('surface-op: 0.1.5-alpha.1 and later speak the new {startSeq,endSeq} shape', () => {
  for (const v of ['0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.6', '0.2.0']) {
    assert.equal(usesNewSurfaceOpShape(v), true, `${v} is new`)
    assert.deepEqual(replaceSurfaceOp(3, 7, v), { op: 'replace', startSeq: 3, endSeq: 7 })
  }
})

test('surface-op: rename boundary compares exactly at 0.1.5-alpha.1', () => {
  assert.equal(compareSurfaceOpVersions('0.1.5-alpha.1', SURFACE_OP_RENAME_VERSION), 0)
  // A pre-release of the same core sorts before its bare release.
  assert.ok(compareSurfaceOpVersions('0.1.5-alpha.1', '0.1.5') < 0)
  // Newest legacy line sorts strictly before the oldest new line.
  assert.ok(compareSurfaceOpVersions('0.1.3-alpha.2', '0.1.5-alpha.1') < 0)
  // Version families that never existed still compare coherently.
  assert.ok(compareSurfaceOpVersions('0.1.4', '0.1.5-alpha.1') < 0)
})

test('surface-op: alpha identifier comparison is numeric where both are numeric', () => {
  assert.ok(compareSurfaceOpVersions('0.1.5-alpha.10', '0.1.5-alpha.2') > 0)
})