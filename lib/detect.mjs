/**
 * 从 dsh-thinking-guard 复制出来的纯检测函数（2026-11-15）。
 * 目的：让 dsh-context-fold 成为独立插件，不 import thinking-guard。
 * 来源：thinking-guard/lib/escape-valve.mjs、lib/detect-v2.mjs、lib/thinking-guard.mjs
 * 改动：windowChars=0 时扫描全文；>0 时只看最近 N 字。
 */

const SPLIT = /[。！？!?\n]+|\.\s+/
const MEANINGFUL = /[A-Za-z0-9\u4e00-\u9fff]/
const CODE_FENCE = /```[\s\S]*?```/g

export function detect(text, cfg = {}) {
  const minRepeats = Number.isSafeInteger(cfg.minRepeats) ? cfg.minRepeats : 25
  const maxUnit = Number.isSafeInteger(cfg.maxUnit) ? cfg.maxUnit : 30
  const tailChars = Number.isSafeInteger(cfg.tailChars) ? cfg.tailChars : 4000
  const minShare = typeof cfg.minShare === 'number' && cfg.minShare >= 0 ? cfg.minShare : 0.20
  const tail = text.length > tailChars ? text.slice(-tailChars) : text
  const parts = tail.split(SPLIT).map((s) => s.trim()).filter((s) => s.length > 0)
  if (parts.length < minRepeats) return null
  const counts = new Map()
  let best = ''
  let bestN = 0
  for (const p of parts) {
    if (p.length > maxUnit) continue
    if (!MEANINGFUL.test(p)) continue
    const n = (counts.get(p) ?? 0) + 1
    counts.set(p, n)
    if (n > bestN) { bestN = n; best = p }
  }
  if (bestN < minRepeats) return null
  const share = bestN / parts.length
  if (share < minShare) return null
  return { unit: best, count: bestN, share, via: 'repeat' }
}

function wordCount(s) {
  return s.toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#\s]/g, ' ').trim().split(/\s+/).filter(Boolean).length
}

export function rotationHit(text, cfg = {}) {
  if (typeof text !== 'string' || text.length === 0) return null
  const tailChars = Number.isFinite(cfg.tailChars) ? cfg.tailChars : 4000
  const shortWordsMax = Number.isFinite(cfg.shortWordsMax) ? cfg.shortWordsMax : 3
  const shortShareMin = Number.isFinite(cfg.shortShareMin) ? cfg.shortShareMin : 0.35
  const topUnitShareMin = Number.isFinite(cfg.topUnitShareMin) ? cfg.topUnitShareMin : 0.5
  const minParts = Number.isFinite(cfg.minParts) ? cfg.minParts : 25
  const tail = (text.length > tailChars ? text.slice(-tailChars) : text).replace(CODE_FENCE, ' ')
  const parts = tail.split(SPLIT).map((s) => s.trim()).filter(Boolean)
  if (parts.length < minParts) return null
  let short = 0
  const counts = new Map()
  for (const p of parts) {
    if (wordCount(p) <= shortWordsMax) short += 1
    if (MEANINGFUL.test(p)) counts.set(p, (counts.get(p) || 0) + 1)
  }
  if (counts.size === 0) return null
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const shortShare = short / parts.length
  const topUnitShare = top.reduce((sum, [, n]) => sum + n, 0) / parts.length
  if (shortShare < shortShareMin || topUnitShare < topUnitShareMin) return null
  return {
    via: 'rotation',
    unit: top[0][0],
    count: top[0][1],
    share: topUnitShare,
    shortShare,
    parts: parts.length,
    top
  }
}

/**
 * 纯函数：找出消息 content 里需要剪掉的退化 reasoning 块。
 * windowChars：0/未设 = 全扫；>0 = 只看最近 N 字。
 */
export function findDegenerate(content, cfg = {}) {
  const minChars = Number.isSafeInteger(cfg.minChars) ? cfg.minChars : 400
  const windowChars = Number.isSafeInteger(cfg.windowChars) ? cfg.windowChars : 0
  const hits = []
  if (!Array.isArray(content)) return hits
  content.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return
    if (block.type !== 'reasoning') return
    const text = typeof block.text === 'string' ? block.text : ''
    if (text.length < minChars) return
    const scanCfg = { ...cfg, tailChars: windowChars > 0 ? windowChars : Math.max(text.length, 4000) }
    const hit = detect(text, scanCfg) ?? (cfg.rotationGuard === false ? null : rotationHit(text, scanCfg))
    if (hit === null) return
    hits.push({ index, chars: text.length, kind: 'degenerate', ...hit })
  })
  return hits
}

function globalPattern(pattern, flags) {
  const safeFlags = typeof flags === 'string' ? flags : 'gm'
  return new RegExp(pattern, safeFlags.includes('g') ? safeFlags : `${safeFlags}g`)
}

/**
 * 按行正则找单个字 + 。的复读行。
 * cfg: { pattern, flags, minMatches, minChars }
 */
export function findRegexMatches(content, cfg = {}) {
  const pattern = typeof cfg.pattern === 'string' ? cfg.pattern : '^[ \\t]*[\\u4e00-\\u9fff]。[ \\t]*$'
  const flags = typeof cfg.flags === 'string' ? cfg.flags : 'gm'
  const minMatches = Number.isSafeInteger(cfg.minMatches) ? cfg.minMatches : 1
  const minChars = Number.isSafeInteger(cfg.minChars) ? cfg.minChars : 0
  const hits = []
  if (!Array.isArray(content)) return hits
  let re
  try { re = globalPattern(pattern, flags) } catch { return hits }
  content.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return
    if (block.type !== 'reasoning') return
    const text = typeof block.text === 'string' ? block.text : ''
    if (text.length < minChars) return
    const matches = [...text.matchAll(re)]
    if (matches.length < minMatches) return
    hits.push({
      index,
      chars: text.length,
      kind: 'regex',
      detector: 'regex',
      unit: matches[0][0].trim(),
      count: matches.length,
      share: 1,
      matches: matches.map((match) => match[0].trim())
    })
  })
  return hits
}

/** 删除命中的行，压掉多余空行。 */
export function cleanRegexLines(text, cfg = {}) {
  const pattern = typeof cfg.pattern === 'string' ? cfg.pattern : '^[ \\t]*[\\u4e00-\\u9fff]。[ \\t]*$'
  const flags = typeof cfg.flags === 'string' ? cfg.flags : 'gm'
  try {
    return text.replace(globalPattern(pattern, flags), '').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return text
  }
}
