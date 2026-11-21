/**
 * 摘要构建：固定句式，保留助理原文 + 工具回执 + 承诺/下一步。
 * 不调用模型；空内容用固定占位（B）。
 */

export const EMPTY_SUMMARY_PLACEHOLDER =
  '⟪context-fold⟫ 该步已折叠（无可保留正文/工具回执）'

export const DEFAULT_SUMMARY_TEMPLATE = `⟪context-fold⟫ 以下为折叠前的助理原文与工具回执，不是用户发言。

【清理后思考】
{{cleanedReasoning}}

【助理原文】
{{assistantText}}

【工具回执】
{{toolReceipts}}

【承诺/下一步】
{{commitments}}

【已移除】
{{removed}}`

function clip(text, limit) {
  if (typeof text !== 'string') return ''
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > limit ? `${one.slice(0, limit)}…` : one
}

function textBlocks(message) {
  if (message === null || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function stripSingleCharLines(text) {
  if (typeof text !== 'string' || text === '') return text
  return text.split(/\r?\n/).filter((line) => !/^[\u4e00-\u9fff]。$/.test(line)).join('\n')
}

function resultText(message) {
  if (message === null || !Array.isArray(message.content)) return ''
  return message.content.map((block) => {
    if (block?.type === 'text') return block.text
    if (block?.type === 'image') {
      const a = block.attachment ?? {}
      return `[image ${a.width ?? '?'}x${a.height ?? '?'} ${a.bytes ?? '?'} bytes]`
    }
    return ''
  }).filter(Boolean).join('\n')
}

function extractCommitments(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const picked = lines.filter((line) => /下一步|待办|我会|我答应|接下来|之后|还要|需要做/.test(line))
  return picked.slice(-5).join('\n')
}

function renderTemplate(template, vars) {
  let out = typeof template === 'string' && template.trim() !== '' ? template : DEFAULT_SUMMARY_TEMPLATE
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value ?? '')
  }
  return out
}

/**
 * @param {object} input
 * @param {object} input.message  assistant 消息（deriveEventMessage）
 * @param {Array} input.calls    tool-call blocks
 * @param {Array} input.results  [{seq, message}] 已按 callId 配对
 * @param {Array} input.hits     findDegenerate 的命中
 * @param {object} input.rule    规则（summaryTemplate / preserve / maxChars）
 */
export function buildAssistantSummary({ message, calls = [], results = [], hits = [], cleanedReasoning = '', rule = {} }) {
  const preserve = rule.preserve ?? {}
  const textChars = Number.isSafeInteger(rule.summaryTextChars) ? rule.summaryTextChars : 2500
  const reasoningChars = Number.isSafeInteger(rule.summaryReasoningChars) ? rule.summaryReasoningChars : 4000
  const receiptChars = Number.isSafeInteger(rule.summaryReceiptChars) ? rule.summaryReceiptChars : 240
  const argsChars = Number.isSafeInteger(rule.summaryArgsChars) ? rule.summaryArgsChars : 160
  const maxReceipts = Number.isSafeInteger(rule.summaryMaxReceipts) ? rule.summaryMaxReceipts : 6

  const assistantTextRaw = stripSingleCharLines(textBlocks(message))
  let assistantText = assistantTextRaw
  if (assistantText.length > textChars) {
    const head = assistantText.slice(0, Math.max(0, textChars - 500))
    const tail = assistantText.slice(-500)
    assistantText = `${head}\n…[中间略]…\n${tail}`
  }

  let cleaned = typeof cleanedReasoning === 'string' ? cleanedReasoning.trim() : ''
  if (reasoningChars > 0 && cleaned.length > reasoningChars) {
    const head = cleaned.slice(0, Math.max(0, reasoningChars - 800))
    const tail = cleaned.slice(-800)
    cleaned = `${head}\n…[中间略]…\n${tail}`
  }

  const byCall = new Map()
  for (const item of results) {
    const callId = item?.message?.toolCallId
    if (typeof callId === 'string') byCall.set(callId, item)
  }

  const receiptLines = []
  if (preserve.tools !== 'none' && calls.length > 0) {
    for (const call of calls.slice(0, maxReceipts)) {
      const result = byCall.get(call.id)
      const resultMessage = result?.message ?? null
      const isError = resultMessage?.isError === true
      const body = clip(resultText(resultMessage), receiptChars) || '（无文本结果）'
      const args = clip(call.arguments, argsChars)
      receiptLines.push(`- ${call.name}(${args}) → ${isError ? '失败' : '成功'}：${body}`)
    }
    if (calls.length > maxReceipts) receiptLines.push(`- （另有 ${calls.length - maxReceipts} 次调用未列出）`)
  }

  const commitments = preserve.commitments === false ? '' : extractCommitments(assistantTextRaw)
  const removedCount = hits.reduce((sum, hit) => sum + (Number(hit.count) || 0), 0)
  const removed = hits.length === 0
    ? ''
    : `已移除退化行 ${removedCount} 行（规则：assistant-regex-clean）`

  const hasContent = cleaned !== '' || assistantText.trim() !== '' || receiptLines.length > 0 || commitments.trim() !== ''
  if (!hasContent) {
    return { text: EMPTY_SUMMARY_PLACEHOLDER, empty: true, usedPlaceholder: true }
  }

  const text = renderTemplate(rule.summaryTemplate, {
    cleanedReasoning: cleaned === '' ? '（无）' : cleaned,
    assistantText: assistantText.trim() === '' ? '（该步没有可见正文）' : assistantText,
    toolReceipts: receiptLines.length === 0 ? '（该步没有工具调用）' : receiptLines.join('\n'),
    commitments: commitments.trim() === '' ? '（无）' : commitments,
    removed: removed === '' ? '（无）' : removed
  })
  return { text, empty: false, usedPlaceholder: false }
}
