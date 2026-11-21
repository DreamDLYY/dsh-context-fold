import test from 'node:test'
import assert from 'node:assert/strict'
import { buildQqInjectionPlan } from '../lib/index.js'
import { makeFakeSession } from './fake-session.mjs'

test('QQ injection plan keeps newest prefix and runtime snapshot', () => {
  const session = makeFakeSession([
    {
      seq: 1,
      type: 'user/message',
      source: { kind: 'aurabot' },
      text: '（你记得这些事，方括号里是什么时候的事：[昨天] 旧记忆）\n【私聊】o(1)：旧消息'
    },
    {
      seq: 2,
      type: 'user/message',
      source: { kind: 'aurabot' },
      text: '（你记得这些事，方括号里是什么时候的事：[今天] 新记忆）\n【私聊】o(1)：新消息'
    },
    {
      seq: 3,
      type: 'user/message',
      source: { kind: 'runtime-context', form: 'snapshot' },
      text: '旧 runtime'
    },
    {
      seq: 4,
      type: 'user/message',
      source: { kind: 'runtime-context', form: 'snapshot' },
      text: '新 runtime'
    }
  ])
  const plan = buildQqInjectionPlan(session)
  assert.equal(plan.entries.length, 2)
  const oldAurabot = plan.entries.find((entry) => entry.seq === 1)
  const oldRuntime = plan.entries.find((entry) => entry.seq === 3)
  assert.ok(oldAurabot.replacement.includes('【私聊】o(1)：旧消息'))
  assert.ok(!oldAurabot.replacement.includes('旧记忆'))
  assert.equal(oldRuntime.replacement, '【runtime-context 已折叠】')
  assert.equal(plan.kept.aurabot, 2)
  assert.equal(plan.kept.runtime, 4)
})
