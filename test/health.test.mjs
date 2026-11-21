import test from 'node:test'
import assert from 'node:assert/strict'
import { healthScan } from '../lib/index.js'
import { makeFakeSession } from './fake-session.mjs'

const fakeMeter = {
  measure: () => ({
    totalTokens: 1000,
    surfaceTokens: 600,
    surfaceDeltaTokens: 0,
    logRevision: 42
  })
}

test('health reports degeneration, markers, prefix, duplicates and pressure', () => {
  const session = makeFakeSession([
    {
      seq: 1,
      type: 'user/message',
      source: { kind: 'aurabot' },
      text: '（你记得这些事，方括号里是什么时候的事：[昨天] 主人喜欢猫）\n【私聊】o(1)：在吗'
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
      text: '同一句话'
    },
    {
      seq: 4,
      type: 'user/message',
      source: { kind: 'user' },
      text: '同一句话'
    },
    {
      seq: 5,
      type: 'assistant/message',
      reasoning: '短。\n好。\n写。\n发。\n行。\n对。'
    },
    {
      seq: 6,
      type: 'user/message',
      source: { kind: 'aurabot' },
      text: '【aurabot 记忆前言已折叠】\n\n【私聊】o(1)：旧标记'
    }
  ])

  const report = healthScan(session, {
    checks: ['degeneration', 'markers', 'prefix', 'duplicates', 'pressure'],
    ctx: { get: () => fakeMeter }
  })

  assert.equal(report.ok, true)
  assert.equal(report.markers.aurabot, 1)
  assert.equal(report.markers.runtime, 1)
  assert.equal(report.markers.total, 2)
  assert.equal(report.prefix.messages, 1)
  assert.ok(report.prefix.prefixChars > 0)
  assert.equal(report.degeneration.messages, 1)
  assert.equal(report.degeneration.singleLines, 6)
  assert.equal(report.duplicates.user.messages, 2)
  assert.equal(report.duplicates.user.exactGroups, 1)
  assert.equal(report.pressure.totalTokens, 1000)
})
