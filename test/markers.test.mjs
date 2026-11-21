import test from 'node:test'
import assert from 'node:assert/strict'
import { buildMarkerPlan, normalizeMarkerRules } from '../lib/index.js'
import { makeFakeSession } from './fake-session.mjs'

test('default marker rules remove aurabot marker and normalize runtime marker', () => {
  const session = makeFakeSession([
    {
      seq: 1,
      type: 'user/message',
      source: { kind: 'aurabot' },
      text: '【aurabot 记忆前言已折叠】\n\n【私聊】o(1)：好哦～'
    },
    {
      seq: 2,
      type: 'user/message',
      source: { kind: 'runtime-context', form: 'snapshot' },
      text: '【runtime-context 已折叠】'
    },
    {
      seq: 3,
      type: 'user/message',
      source: { kind: 'user' },
      text: '普通消息'
    }
  ])
  const plan = buildMarkerPlan(session)
  assert.equal(plan.entries.length, 2)
  const aurabot = plan.entries.find((entry) => entry.seq === 1)
  const runtime = plan.entries.find((entry) => entry.seq === 2)
  assert.equal(aurabot.replacement, '【私聊】o(1)：好哦～')
  assert.equal(runtime.replacement, ' ')
  assert.equal(plan.entries.some((entry) => entry.seq === 3), false)
})

test('prefix marker keeps the body exactly', () => {
  const body = '\n【私聊】o(1)：正文不能丢'
  const session = makeFakeSession([
    { seq: 1, type: 'user/message', source: { kind: 'aurabot' }, text: '【aurabot 记忆前言已折叠】' + body }
  ])
  const plan = buildMarkerPlan(session)
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].replacement, body.trimStart())
})

test('custom regex replacement is supported', () => {
  const session = makeFakeSession([
    { seq: 1, type: 'user/message', source: { kind: 'user' }, text: '前【已折叠】后' }
  ])
  const plan = buildMarkerPlan(session, [
    {
      id: 'custom',
      match: { mode: 'regex', pattern: '【[^】]*已折叠】', flags: 'g' },
      replace: ''
    }
  ])
  assert.equal(plan.entries.length, 1)
  assert.equal(plan.entries[0].replacement, '前后')
})

test('marker cleanup is idempotent when markers are already gone', () => {
  const session = makeFakeSession([
    { seq: 1, type: 'user/message', source: { kind: 'aurabot' }, text: '【私聊】o(1)：正文' },
    { seq: 2, type: 'user/message', source: { kind: 'runtime-context', form: 'snapshot' }, text: ' ' }
  ])
  const plan = buildMarkerPlan(session)
  assert.equal(plan.entries.length, 0)
})

test('normalizeMarkerRules keeps a valid source filter', () => {
  const rules = normalizeMarkerRules([
    {
      id: 'x',
      match: { source: { kind: 'aurabot' }, mode: 'prefix', pattern: 'M' },
      replace: ''
    }
  ])
  assert.equal(rules[0].match.source.kind, 'aurabot')
  assert.equal(rules[0].match.mode, 'prefix')
})
