/**
 * LruMap unit tests: cap enforcement, recency refresh on get AND set,
 * iteration order = recency order (issue #113).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LruMap } from '../src/lru.ts'

test('LRU: evicts the least recently used entry when over the cap', () => {
  const map = new LruMap<string, number>(3)
  map.set('a', 1)
  map.set('b', 2)
  map.set('c', 3)
  assert.equal(map.get('a'), 1, 'get returns the value')
  map.set('d', 4)
  assert.equal(map.size, 3)
  assert.equal(map.has('a'), true, 'the just-read entry survived')
  assert.equal(map.has('b'), false, 'the coldest entry was evicted')
  assert.equal(map.has('c'), true)
  assert.equal(map.has('d'), true)
})

test('LRU: re-setting a key refreshes its recency', () => {
  const map = new LruMap<string, number>(2)
  map.set('a', 1)
  map.set('b', 2)
  map.set('a', 10)
  map.set('c', 3)
  assert.deepEqual([...map.keys()], ['a', 'c'], 're-set moved a ahead of b; b evicted as coldest')
  assert.equal(map.has('b'), false)
  assert.equal(map.get('a'), 10)
})

test('LRU: delete removes without evicting other entries', () => {
  const map = new LruMap<string, number>(2)
  map.set('a', 1)
  map.set('b', 2)
  assert.equal(map.delete('a'), true)
  map.set('c', 3)
  assert.deepEqual([...map.keys()], ['b', 'c'])
  assert.equal(map.delete('missing'), false)
})

test('LRU: clamps the cap to at least one entry', () => {
  const map = new LruMap<string, number>(0)
  map.set('a', 1)
  assert.equal(map.size, 1)
  map.set('b', 2)
  assert.deepEqual([...map.keys()], ['b'])
})
