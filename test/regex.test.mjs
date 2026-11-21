import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMarkerRules } from '../lib/index.js'

test('invalid regex returns a readable error', () => {
  assert.throws(
    () => normalizeMarkerRules([
      { id: 'bad-regex', match: { mode: 'regex', pattern: '[', flags: '' }, replace: '' }
    ]),
    /正则无效|Invalid regular expression/
  )
})

test('empty pattern is rejected', () => {
  assert.throws(
    () => normalizeMarkerRules([{ id: 'empty', match: { mode: 'exact', pattern: '' }, replace: '' }]),
    /pattern 不能为空/
  )
})

test('unsupported flags are rejected', () => {
  assert.throws(
    () => normalizeMarkerRules([{ id: 'flags', match: { mode: 'regex', pattern: 'x', flags: 'z' }, replace: '' }]),
    /flags 只允许/
  )
})

test('overlong pattern is rejected', () => {
  assert.throws(
    () => normalizeMarkerRules([{ id: 'long', match: { mode: 'exact', pattern: 'x'.repeat(2001) }, replace: '' }]),
    /超过 2000/
  )
})

test('valid regex compiles', () => {
  const rules = normalizeMarkerRules([
    { id: 'ok', match: { mode: 'regex', pattern: '【[^】]+】', flags: 'g' }, replace: ' ' }
  ])
  assert.equal(rules[0].match.pattern, '【[^】]+】')
  assert.equal(rules[0].match.flags, 'g')
})
