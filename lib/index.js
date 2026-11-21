/**
 * dsh-context-fold —— 按压力阈值读取规则文档，把命中的模型可见上下文折叠掉。
 *
 * 设计约束（2026-11-15 与主人定稿）：
 * - 只改 session.surface，不改 session.v4.jsonl；替换用 surfaceOp replace；
 * - 阈值数组只放压力比例，不绑定规则；触发后按 ruleDir/<阈值>.yml 寻址；
 * - 寻址失败用 default.yml；
 * - 备份优先于 100MB 上限：先写备份，再清理；备份写失败才停止；
 * - 默认 dry-run；apply 前重新校验 seq，防折错。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findDegenerate, findRegexMatches, cleanRegexLines } from './detect.mjs';
import { buildAssistantSummary, EMPTY_SUMMARY_PLACEHOLDER } from './summary.mjs';

export const name = 'dsh-context-fold';
export const inject = ['tools'];

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join('E:\\小鲸的日常', 'context-fold.log');
const PLAN_DIR = path.join('E:\\小鲸的日常', 'context-fold-plans');

const DEFAULTS = {
  targetSession: '',
  mode: 'dry-run',
  backup: {
    dir: 'E:\\小鲸的日常\\context-fold-backups',
    capBytes: 104857600,
    policy: 'rotate-oldest',
    rotateGroups: 3,
    hook: null,
    notifyAfter: true
  },
  trigger: {
    mode: 'array',
    thresholds: [0.2, 0.4, 0.5, 0.7],
    combiner: 'threshold-rulefile',
    ruleDir: 'E:\\小鲸的日常\\context-fold-rules',
    defaultRuleFile: 'default.yml',
    balanced: { start: 0.2, trick: 0.2 },
    manual: true
  },
  preview: { requireApproval: true, autoApprove: false, maxMatches: 200 }
};

function log(line) {
  try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
}
function warn(ctx, line) {
  log(`WARN ${line}`);
  try { ctx.logger?.warn?.(`[context-fold] ${line}`); } catch { /* ignore */ }
}
function deepMerge(base, override) {
  if (override === null || override === undefined) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== 'object' || typeof override !== 'object') return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = deepMerge(base[key], value);
  return out;
}
function normalizeThreshold(value) {
  return String(Number(value));
}
function textOf(message) {
  if (message === null || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block !== null && typeof block === 'object' && (block.type === 'text' || block.type === 'reasoning'))
    .map((block) => (typeof block.text === 'string' ? block.text : ''))
    .join('\n');
}
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function signature(text, k = 64) {
  const t = text.replace(/\s+/g, '');
  if (t.length < 100) return new Set();
  const set = new Set();
  for (let i = 0; i < t.length - 2; i += 1) set.add(hash32(t.slice(i, i + 3)));
  const sorted = [...set].sort((a, b) => a - b);
  return new Set(sorted.slice(0, k));
}
function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) hit += 1;
  return hit / small.size;
}
function sourceOf(message) {
  const source = message?.source;
  return source && typeof source === 'object' ? source : {};
}
function matchesSource(rule, message) {
  const expected = rule?.match?.source;
  if (expected === undefined) return true;
  const source = sourceOf(message);
  if (expected.kind !== undefined && source.kind !== expected.kind) return false;
  if (expected.form !== undefined && source.form !== expected.form) return false;
  return true;
}
function parseSimpleYaml(text) {
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length;
    lines.push({ indent, content: raw.trim() });
  }
  let i = 0;
  const scalar = (value) => {
    const v = value.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null') return null;
    if (v.startsWith('{') || v.startsWith('[')) {
      try { return JSON.parse(v); } catch { return v; }
    }
    const n = Number(v);
    return Number.isFinite(n) && v !== '' ? n : v;
  };
  const block = (indent) => {
    if (lines[i] !== undefined && lines[i].indent === indent && lines[i].content.startsWith('- ')) return list(indent);
    return map(indent);
  };
  const map = (indent) => {
    const obj = {};
    while (lines[i] !== undefined && lines[i].indent === indent && !lines[i].content.startsWith('- ')) {
      const match = lines[i].content.match(/^([^:]+):\s*(.*)$/);
      if (match === null) break;
      const key = match[1].trim();
      const rest = match[2].trim();
      i += 1;
      if (rest === '') obj[key] = lines[i] !== undefined && lines[i].indent > indent ? block(lines[i].indent) : null;
      else obj[key] = scalar(rest);
    }
    return obj;
  };
  const list = (indent) => {
    const out = [];
    while (lines[i] !== undefined && lines[i].indent === indent && lines[i].content.startsWith('- ')) {
      const rest = lines[i].content.slice(2).trim();
      i += 1;
      const match = rest.match(/^([^:]+):\s*(.*)$/);
      if (match === null) {
        out.push(scalar(rest));
        continue;
      }
      const obj = {};
      const key = match[1].trim();
      const value = match[2].trim();
      if (value === '') obj[key] = lines[i] !== undefined && lines[i].indent > indent ? block(lines[i].indent) : null;
      else obj[key] = scalar(value);
      while (lines[i] !== undefined && lines[i].indent > indent && !lines[i].content.startsWith('- ')) {
        const more = lines[i].content.match(/^([^:]+):\s*(.*)$/);
        if (more === null) break;
        const k = more[1].trim();
        const v = more[2].trim();
        i += 1;
        if (v === '') obj[k] = lines[i] !== undefined && lines[i].indent > indent ? block(lines[i].indent) : null;
        else obj[k] = scalar(v);
      }
      out.push(obj);
    }
    return out;
  };
  return block(lines[0]?.indent ?? 0);
}

function readRuleFile(file) {
  const ext = path.extname(file).toLowerCase();
  const raw = fs.readFileSync(file, 'utf8');
  if (ext === '.json') return JSON.parse(raw);
  return parseSimpleYaml(raw);
}
function loadRules(config, threshold, overrideFile) {
  const dir = path.isAbsolute(config.trigger.ruleDir)
    ? config.trigger.ruleDir
    : path.resolve(PACKAGE_ROOT, config.trigger.ruleDir);
  const candidates = [];
  if (overrideFile) candidates.push(path.isAbsolute(overrideFile) ? overrideFile : path.join(dir, overrideFile));
  if (config.trigger.combiner === 'threshold-rulefile') {
    const key = normalizeThreshold(threshold);
    for (const ext of ['yml', 'yaml', 'json']) candidates.push(path.join(dir, `${key}.${ext}`));
  }
  const fallback = path.join(dir, config.trigger.defaultRuleFile || 'default.yml');
  candidates.push(fallback);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const doc = readRuleFile(file);
      const rules = Array.isArray(doc?.rules) ? doc.rules : Array.isArray(doc) ? doc : [];
      if (rules.length > 0) {
        log(`规则文件 ${file}: ${rules.length} 条 ${JSON.stringify(rules[0]).slice(0, 500)}`);
        return { file, rules };
      }    } catch (error) {
      log(`规则文件解析失败 ${file}: ${String(error)}`);
    }
  }
  throw new Error(`RULE_NOT_FOUND: ${candidates.join(', ')}`);
}
function groupBySimilarity(items, threshold) {
  const parent = items.map((_, index) => index);
  const find = (x) => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const li = items[i].text.length;
      const lj = items[j].text.length;
      if (Math.abs(li - lj) > Math.max(li, lj) * 0.35) continue;
      if (similarity(items[i].sig, items[j].sig) >= threshold) {
        const a = find(i); const b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(items[i]);
  }
  return [...groups.values()];
}
function groupByExact(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.text.replace(/\s+/g, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}
function ruleTarget(rule) {
  return rule?.target === 'assistant-step' ? 'assistant-step' : 'user-message';
}

function detectorConfig(rule) {
  const match = rule?.match ?? {};
  return {
    minChars: Number.isSafeInteger(match.minChars) ? match.minChars : 400,
    minRepeats: Number.isSafeInteger(match.minRepeats) ? match.minRepeats : 25,
    minShare: typeof match.minShare === 'number' ? match.minShare : 0.20,
    maxUnit: Number.isSafeInteger(match.maxUnit) ? match.maxUnit : 30,
    windowChars: Number.isSafeInteger(match.windowChars) ? match.windowChars : 0,
    rotationGuard: match.rotationGuard !== false
  };
}

function regexConfig(rule) {
  const match = rule?.match ?? {};
  return {
    pattern: typeof match.pattern === 'string' ? match.pattern : '^[ \t]*[\\u4e00-\\u9fff]。[ \t]*$',
    flags: typeof match.flags === 'string' ? match.flags : 'gm',
    minMatches: Number.isSafeInteger(match.minMatches) ? match.minMatches : 1,
    maxMatches: Number.isSafeInteger(match.maxMatches) ? match.maxMatches : 0,
    minChars: Number.isSafeInteger(match.minChars) ? match.minChars : 0
  };
}

function planAssistantSpan(session, assistantSeq) {
  const nodes = [...session.surface.nodes];
  const start = nodes.indexOf(assistantSeq);
  if (start < 0) return { ok: false, why: 'not-in-surface' };
  const event = session.eventAt(assistantSeq);
  const message = session.deriveEventMessage(event);
  const calls = (message?.content ?? []).filter((block) => block?.type === 'tool-call');
  if (calls.length === 0) return { ok: true, span: [Number(assistantSeq)], calls: [], results: [] };
  const expected = new Map(calls.map((call) => [String(call.id), call]));
  const span = [Number(assistantSeq)];
  const results = [];
  const matched = new Set();
  for (let i = start + 1; i < nodes.length && matched.size < expected.size; i += 1) {
    const seq = Number(nodes[i]);
    const ev = session.eventAt(nodes[i]);
    if (ev?.type !== 'tool/result') break;
    const resultMessage = session.deriveEventMessage(ev);
    const callId = String(resultMessage?.toolCallId ?? '');
    if (!expected.has(callId) || matched.has(callId)) {
      return { ok: false, why: 'unexpected-or-duplicate-result', seq };
    }
    matched.add(callId);
    span.push(seq);
    results.push({ seq, message: resultMessage });
  }
  if (matched.size < expected.size) {
    return { ok: false, why: 'incomplete-pairing', have: matched.size, need: expected.size };
  }
  return { ok: true, span, calls, results };
}

function assistantCandidates(session, rule) {
  const items = [];
  const useRegex = rule?.type === 'regex';
  const cfg = useRegex ? regexConfig(rule) : detectorConfig(rule);
  let total = 0;
  let hitCount = 0;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'assistant/message' || event.surfaceOp !== 'append') continue;
    total += 1;
    const message = session.deriveEventMessage(event);
    if (message === null || !Array.isArray(message.content)) continue;
    const hits = useRegex ? findRegexMatches(message.content, cfg) : findDegenerate(message.content, cfg);
    if (hits.length === 0) continue;
    const totalHits = hits.reduce((sum, hit) => sum + (Number(hit.count) || 0), 0);
    if (useRegex && cfg.maxMatches > 0 && totalHits > cfg.maxMatches) continue;
    hitCount += 1;
    const span = planAssistantSpan(session, Number(seq));
    if (!span.ok) {
      log(`跳过 assistant seq ${seq}：${span.why}${span.have === undefined ? '' : ` ${span.have}/${span.need}`}`);
      continue;
    }
    items.push({
      seq: Number(seq),
      event,
      message,
      hits,
      span: span.span,
      calls: span.calls,
      results: span.results,
      ruleId: rule.id ?? 'assistant-regex',
      clean: useRegex ? cfg : null
    });
  }
  log(`assistant 扫描：规则 ${rule.id}，assistant=${total}，命中=${hitCount}，可折=${items.length}`);
  return items;
}

function hashSpan(session, span) {
  const parts = [];
  for (const seq of span) {
    const event = session.eventAt(seq);
    if (event === undefined) return null;
    parts.push(JSON.stringify(event.data));
  }
  return hash32(parts.join('|'));
}

function spanChars(session, span) {
  let total = 0;
  for (const seq of span) {
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    const message = event.type === 'user/message' ? event.data : event.data?.message;
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' || block?.type === 'reasoning') total += block.text?.length ?? 0;
      else if (block?.type === 'tool-call') total += block.arguments?.length ?? 0;
    }
  }
  return total;
}

function candidatesForRule(session, rule, config) {
  const items = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message' || event.surfaceOp !== 'append') continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    if (!matchesSource(rule, message)) continue;
    const text = textOf(message);
    if (text.length < (rule.match?.minLen ?? 0)) continue;
    if (rule.match?.maxLen !== undefined && text.length > rule.match.maxLen) continue;
    items.push({ seq: Number(seq), time: event.time, message, text, sig: signature(text), ruleId: rule.id ?? 'rule' });
  }
  if (rule.type === 'regex') {
    const pattern = rule.match?.pattern;
    if (typeof pattern !== 'string') return [];
    let re;
    try { re = new RegExp(pattern, rule.match?.flags ?? ''); } catch { return []; }
    return items.filter((item) => re.test(item.text));
  }
  return items;
}
function buildPlan(session, rules, config, meta) {
  const entries = [];
  const seen = new Set();
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (ruleTarget(rule) === 'assistant-step') {
      const assistantItems = assistantCandidates(session, rule);
      for (const item of assistantItems) {
        if (entries.length >= (config.preview.maxMatches ?? 200)) break;
        const text = textOf(item.message);
        const summaryRule = {
          preserve: rule.preserve ?? {},
          summaryTemplate: rule.summaryTemplate,
          summaryTextChars: rule.summaryTextChars,
          summaryReasoningChars: rule.summaryReasoningChars,
          summaryReceiptChars: rule.summaryReceiptChars,
          summaryArgsChars: rule.summaryArgsChars,
          summaryMaxReceipts: rule.summaryMaxReceipts
        };
        const rawReasoning = (item.message?.content ?? [])
          .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n');
        const cleanedReasoning = item.clean === null || item.clean === undefined
          ? rawReasoning
          : cleanRegexLines(rawReasoning, item.clean);
        const summary = buildAssistantSummary({
          message: item.message,
          calls: item.calls,
          results: item.results,
          hits: item.hits,
          cleanedReasoning,
          rule: summaryRule
        });
        const originalSpanChars = spanChars(session, item.span);
        entries.push({
          seq: item.seq,
          endSeq: item.span[item.span.length - 1],
          span: item.span,
          time: item.event.time,
          ruleId: item.ruleId,
          kind: 'assistant-step',
          type: 'degenerate',
          chars: item.hits.reduce((sum, hit) => sum + (hit.chars ?? 0), 0),
          textChars: text.length,
          toolCount: item.calls.length,
          hits: item.hits,
          clean: item.clean,
          summaryRule,
          spanChars: originalSpanChars,
          summaryChars: summary.text.length,
          summaryDelta: summary.text.length - originalSpanChars,
          summaryHead: summary.text.slice(0, 300),
          snippet: text.replace(/\s+/g, ' ').slice(0, 120) || String(item.hits[0]?.unit ?? '').slice(0, 120),
          sourceKind: 'assistant',
          sourceForm: '',
          hash: hashSpan(session, item.span)
        });
      }
      continue;
    }
    const items = candidatesForRule(session, rule, config);
    if (items.length === 0) continue;
    let groups = [];
    if (rule.type === 'dedup') groups = groupBySimilarity(items, rule.threshold ?? 0.95);
    else if (rule.type === 'exact') groups = groupByExact(items);
    else if (rule.type === 'regex') groups = items.map((item) => [item]);
    else if (rule.type === 'source' || rule.type === 'length') groups = [items];
    else continue;
    for (const group of groups) {
      const sorted = [...group].sort((a, b) => (a.time - b.time) || (a.seq - b.seq));
      const keep = rule.keep === 'newest' ? Math.max(1, rule.keepRecent ?? 1) : rule.type === 'regex' ? 0 : 0;
      const keepSeqs = new Set(sorted.slice(-keep).map((item) => item.seq));
      for (const item of sorted) {
        if (keepSeqs.has(item.seq)) continue;
        if (seen.has(item.seq)) continue;
        seen.add(item.seq);
        entries.push({
          seq: item.seq,
          endSeq: item.seq,
          span: [item.seq],
          time: item.time,
          ruleId: item.ruleId,
          kind: 'user-message',
          type: rule.type,
          chars: item.text.length,
          snippet: item.text.replace(/\s+/g, ' ').slice(0, 120),
          sourceKind: sourceOf(item.message).kind ?? '',
          sourceForm: sourceOf(item.message).form ?? '',
          hash: hash32(`${eventTypeOf(item)}:${item.text}`)
        });
        if (entries.length >= (config.preview.maxMatches ?? 200)) break;
      }
      if (entries.length >= (config.preview.maxMatches ?? 200)) break;
    }
    if (entries.length >= (config.preview.maxMatches ?? 200)) break;
  }
  entries.sort((a, b) => a.seq - b.seq);
  return {
    planId: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    threshold: meta?.threshold ?? null,
    ruleFile: meta?.ruleFile ?? null,
    entries,
    estimatedChars: entries.reduce((sum, entry) => sum + entry.chars, 0)
  };
}
function eventTypeOf(item) {
  return 'user/message';
}
function writePlanReport(plan) {
  try {
    fs.mkdirSync(PLAN_DIR, { recursive: true });
    const base = path.join(PLAN_DIR, plan.planId);
    fs.writeFileSync(`${base}.json`, JSON.stringify(plan, null, 2), 'utf8');
    const lines = [
      `# context-fold plan ${plan.planId}`,
      '',
      `- createdAt: ${plan.createdAt}`,
      `- threshold: ${plan.threshold}`,
      `- ruleFile: ${plan.ruleFile}`,
      `- entries: ${plan.entries.length}`,
      `- estimatedChars: ${plan.estimatedChars}`,
      '',
      '| seq | end | kind | rule | chars | spanChars | summaryChars | delta | snippet |',
      '|---:|---:|---|---|---:|---:|---:|---:|---|'
    ];
    for (const entry of plan.entries) {
      const span = entry.span === undefined ? String(entry.seq) : `${entry.span[0]}..${entry.span[entry.span.length - 1]}`;
      lines.push(`| ${span} | ${entry.endSeq ?? entry.seq} | ${entry.kind ?? 'user-message'} | ${entry.ruleId} | ${entry.chars} | ${entry.spanChars ?? ''} | ${entry.summaryChars ?? ''} | ${entry.summaryDelta ?? ''} | ${entry.snippet.replace(/\|/g, '\\|')} |`);
    }
    fs.writeFileSync(`${base}.md`, lines.join('\n'), 'utf8');
    return `${base}.md`;
  } catch (error) {
    log(`写 plan 报告失败: ${String(error)}`);
    return null;
  }
}
function backupEntries(session, plan, config) {
  const dir = path.join(config.backup.dir, String(session.id));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${plan.planId}.jsonl`);
  const lines = [];
  for (const entry of plan.entries) {
    const seqs = Array.isArray(entry.span) && entry.span.length > 0 ? entry.span : [entry.seq];
    for (const seq of seqs) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      lines.push(JSON.stringify({ seq, event }));
    }
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  enforceCap(dir, config.backup);
  return file;
}
function dirSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, name)).size; } catch { /* ignore */ }
  }
  return total;
}
function enforceCap(dir, backupConfig) {
  const cap = Number(backupConfig.capBytes ?? 104857600);
  let files = fs.readdirSync(dir)
    .map((name) => ({ name, full: path.join(dir, name) }))
    .map((item) => ({ ...item, stat: fs.statSync(item.full) }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
  if (dirSize(dir) <= cap) return;
  if (backupConfig.policy === 'delete-half') {
    const half = Math.max(1, Math.ceil(files.length / 2));
    for (const item of files.slice(0, half)) {
      try { fs.unlinkSync(item.full); } catch { /* ignore */ }
    }
  } else if (backupConfig.policy === 'custom') {
    // 1.3 只预留 hook；未实现时退回 rotate-oldest，避免静默不动。
    log('WARN backup.policy=custom 但未配置 hook，退回 rotate-oldest');
    files = files.slice(0, Math.max(1, backupConfig.rotateGroups ?? 3));
    for (const item of files) {
      try { fs.unlinkSync(item.full); } catch { /* ignore */ }
    }
  } else {
    let index = 0;
    while (dirSize(dir) > cap && index < files.length) {
      for (let n = 0; n < (backupConfig.rotateGroups ?? 3) && index < files.length; n += 1, index += 1) {
        try { fs.unlinkSync(files[index].full); } catch { /* ignore */ }
      }
    }
  }
  if (dirSize(dir) > cap) {
    log(`WARN 清理后备份仍超过 capBytes=${cap}，保留备份并继续`);
  }
}
function buildQqInjectionPlan(session) {
  const aurabot = [];
  const runtime = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message' || event.surfaceOp !== 'append') continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    const source = sourceOf(message);
    const text = textOf(message);
    if (source.kind === 'aurabot' && text.startsWith('（你记得这些事')) {
      const idx = text.indexOf('\n【私聊】');
      if (idx > 0) {
        aurabot.push({ seq: Number(seq), event, message, text, prefix: text.slice(0, idx), suffix: text.slice(idx) });
      }
    } else if (source.kind === 'runtime-context' && source.form === 'snapshot') {
      runtime.push({ seq: Number(seq), event, message, text });
    }
  }
  const keepAurabot = aurabot.reduce((max, item) => (max === null || item.seq > max ? item.seq : max), null);
  const keepRuntime = runtime.reduce((max, item) => (max === null || item.seq > max ? item.seq : max), null);
  const entries = [];
  let saved = 0;
  for (const item of aurabot) {
    if (item.seq === keepAurabot) continue;
    const replacement = '【aurabot 记忆前言已折叠】\n' + item.suffix;
    saved += Math.max(0, item.text.length - replacement.length);
    entries.push({
      seq: item.seq,
      kind: 'user-message',
      ruleId: 'aurabot-prefix',
      chars: item.prefix.length,
      replacement,
      hash: hash32(`user/message:${item.text}`),
      snippet: item.text.replace(/\s+/g, ' ').slice(0, 120)
    });
  }
  for (const item of runtime) {
    if (item.seq === keepRuntime) continue;
    const replacement = '【runtime-context 已折叠】';
    saved += Math.max(0, item.text.length - replacement.length);
    entries.push({
      seq: item.seq,
      kind: 'user-message',
      ruleId: 'runtime-context-dedup',
      chars: item.text.length,
      replacement,
      hash: hash32(`user/message:${item.text}`),
      snippet: item.text.replace(/\s+/g, ' ').slice(0, 120)
    });
  }
  return {
    planId: `qq-injections-${Date.now().toString(36)}`,
    entries,
    estimatedChars: saved,
    kept: { aurabot: keepAurabot, runtime: keepRuntime }
  };
}

const DEFAULT_MARKER_RULES = [
  {
    id: 'aurabot-marker',
    match: { source: { kind: 'aurabot' }, mode: 'prefix', pattern: '【aurabot 记忆前言已折叠】' },
    replace: '',
    trimLeadingNewlines: true,
    hook: null
  },
  {
    id: 'runtime-marker',
    match: { source: { kind: 'runtime-context', form: 'snapshot' }, mode: 'exact', pattern: '【runtime-context 已折叠】' },
    replace: ' ',
    hook: null
  }
];

function normalizeMarkerRules(rules) {
  const list = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_MARKER_RULES;
  return list.map((rule, index) => {
    const id = typeof rule?.id === 'string' && rule.id.length > 0 ? rule.id : `marker-${index + 1}`;
    const match = rule?.match && typeof rule.match === 'object' ? rule.match : {};
    const mode = match.mode ?? 'exact';
    const pattern = match.pattern;
    const flags = match.flags ?? '';
    if (!['exact', 'prefix', 'regex'].includes(mode)) {
      throw new Error(`规则 ${id}: match.mode 必须是 exact / prefix / regex`);
    }
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error(`规则 ${id}: match.pattern 不能为空`);
    }
    if (pattern.length > 2000) {
      throw new Error(`规则 ${id}: match.pattern 超过 2000 字符上限`);
    }
    if (typeof flags !== 'string' || !/^[gimsuy]*$/.test(flags)) {
      throw new Error(`规则 ${id}: match.flags 只允许 g i m s u y`);
    }
    if (mode === 'regex') {
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        throw new Error(`规则 ${id}: 正则无效 (${pattern}, flags=${flags}): ${String(error)}`);
      }
    }
    if (rule?.replace !== undefined && typeof rule.replace !== 'string') {
      throw new Error(`规则 ${id}: replace 必须是字符串`);
    }
    if (rule?.hook !== undefined && rule.hook !== null && typeof rule.hook !== 'string') {
      throw new Error(`规则 ${id}: hook 必须是字符串或 null`);
    }
    return {
      ...rule,
      id,
      match: { ...match, mode, pattern, flags },
      replace: rule?.replace ?? '',
      hook: rule?.hook ?? null
    };
  });
}

function buildMarkerPlan(session, rules) {
  const normalized = normalizeMarkerRules(rules);
  const entries = [];
  const byRule = new Map();
  let saved = 0;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    const text = textOf(message);
    for (const rule of normalized) {
      if (!matchesSource(rule, message)) continue;
      const { mode, pattern, flags } = rule.match;
      let matched = false;
      let replacement = text;
      if (mode === 'exact') {
        matched = text === pattern;
        if (matched) replacement = rule.replace;
      } else if (mode === 'prefix') {
        matched = text.startsWith(pattern);
        if (matched) replacement = rule.replace + text.slice(pattern.length);
      } else {
        const re = new RegExp(pattern, flags);
        matched = re.test(text);
        if (matched) replacement = text.replace(re, rule.replace);
      }
      if (!matched || replacement === text) continue;
      if (rule.trimLeadingNewlines === true) {
        replacement = replacement.replace(/^\n+/, '');
      }
      const chars = text.length;
      const afterChars = replacement.length;
      saved += Math.max(0, chars - afterChars);
      const bucket = byRule.get(rule.id) ?? { ruleId: rule.id, count: 0, chars: 0 };
      bucket.count += 1;
      bucket.chars += chars;
      byRule.set(rule.id, bucket);
      entries.push({
        seq: Number(seq),
        kind: 'user-message',
        ruleId: rule.id,
        chars,
        replacement,
        hash: hash32(`user/message:${text}`),
        snippet: text.replace(/\s+/g, ' ').slice(0, 120)
      });
      break;
    }
  }
  return {
    planId: `markers-${Date.now().toString(36)}`,
    entries,
    estimatedChars: saved,
    byRule: [...byRule.values()],
    rules: normalized.map((rule) => ({ id: rule.id, mode: rule.match.mode, pattern: rule.match.pattern, replace: rule.replace, hook: rule.hook }))
  };
}

function healthScan(session, options = {}) {
  const checks = Array.isArray(options.checks) && options.checks.length > 0
    ? new Set(options.checks)
    : new Set(['degeneration', 'duplicates', 'prefix', 'markers', 'pressure']);
  const sourceFilter = Array.isArray(options.sources) && options.sources.length > 0
    ? new Set(options.sources.map(String))
    : null;
  const maxMessages = Number.isSafeInteger(options.maxMessages) && options.maxMessages > 0
    ? Math.min(options.maxMessages, 10000)
    : 5000;
  const nearThreshold = Number.isFinite(options.nearThreshold) ? options.nearThreshold : 0.95;
  const singleRe = /^[\u4e00-\u9fff]。$/;
  const pairRe = /([\u4e00-\u9fff])[。！？，、；：]([\u4e00-\u9fff])[。！？，、；：]/g;
  const userItems = [];
  const assistantItems = [];
  const degeneration = { messages: 0, singleLines: 0, pairs: 0, topUnits: {} };
  for (const seq of session.surface.nodes.slice(-maxMessages)) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const message = session.deriveEventMessage(event);
    if (message === null) continue;
    const source = sourceOf(message);
    const text = textOf(message);
    if (event.type === 'user/message') {
      const key = source.form ? `${source.kind}/${source.form}` : String(source.kind ?? '?');
      if (sourceFilter !== null && !sourceFilter.has(key) && !sourceFilter.has(String(source.kind ?? ''))) continue;
      userItems.push({ seq: Number(seq), kind: String(source.kind ?? '?'), form: String(source.form ?? ''), text });
      continue;
    }
    if (!checks.has('degeneration')) continue;
    const reasoning = (message.content ?? [])
      .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (reasoning.length === 0) continue;
    const singles = reasoning.split(/\r?\n/).filter((line) => singleRe.test(line));
    const pairs = [...reasoning.matchAll(pairRe)].map((match) => match[0]);
    if (singles.length === 0 && pairs.length === 0) continue;
    degeneration.messages += 1;
    degeneration.singleLines += singles.length;
    degeneration.pairs += pairs.length;
    for (const line of singles) {
      const unit = line.slice(0, 1);
      degeneration.topUnits[unit] = (degeneration.topUnits[unit] ?? 0) + 1;
    }
    assistantItems.push({ seq: Number(seq), singles: singles.length, pairs: pairs.length });
  }

  const result = { ok: true };
  if (checks.has('degeneration')) result.degeneration = degeneration;

  if (checks.has('markers')) {
    const markers = { aurabot: 0, runtime: 0, other: 0, total: 0 };
    for (const item of userItems) {
      if (item.text.startsWith('【aurabot 记忆前言已折叠】')) markers.aurabot += 1;
      else if (item.text === '【runtime-context 已折叠】') markers.runtime += 1;
      else if (item.text.includes('已折叠')) markers.other += 1;
      else continue;
      markers.total += 1;
    }
    result.markers = markers;
  }

  if (checks.has('prefix')) {
    let count = 0;
    let prefixChars = 0;
    let bodyChars = 0;
    for (const item of userItems) {
      if (item.kind !== 'aurabot' || !item.text.startsWith('（你记得这些事')) continue;
      const idx = item.text.indexOf('\n【私聊】');
      if (idx <= 0) continue;
      count += 1;
      prefixChars += idx;
      bodyChars += item.text.length - idx;
    }
    result.prefix = { messages: count, prefixChars, bodyChars };
  }

  if (checks.has('duplicates')) {
    const groups = new Map();
    for (const item of userItems) {
      const key = item.form ? `${item.kind}/${item.form}` : item.kind;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const duplicateReport = {};
    for (const [key, items] of groups) {
      if (items.length < 2) continue;
      const exact = new Map();
      for (const item of items) {
        const hash = hash32(item.text);
        if (!exact.has(hash)) exact.set(hash, []);
        exact.get(hash).push(item);
      }
      const exactGroups = [...exact.values()].filter((group) => group.length > 1);
      const exactWaste = exactGroups.reduce((sum, group) => {
        const sorted = [...group].sort((a, b) => a.seq - b.seq);
        return sum + sorted.slice(0, -1).reduce((inner, item) => inner + item.text.length, 0);
      }, 0);
      let near = [];
      if (items.length <= 120) {
        const candidates = items.map((item) => ({ ...item, sig: signature(item.text) }));
        near = groupBySimilarity(candidates, nearThreshold).filter((group) => group.length > 1);
      }
      const nearWaste = near.reduce((sum, group) => {
        const sorted = [...group].sort((a, b) => a.seq - b.seq);
        return sum + sorted.slice(0, -1).reduce((inner, item) => inner + item.text.length, 0);
      }, 0);
      duplicateReport[key] = {
        messages: items.length,
        chars: items.reduce((sum, item) => sum + item.text.length, 0),
        exactGroups: exactGroups.length,
        exactWasteChars: exactWaste,
        nearGroups: near.length,
        nearWasteChars: nearWaste,
        nearChecked: items.length <= 120
      };
    }
    result.duplicates = duplicateReport;
  }

  const meter = options.ctx?.get('tokenMeter');
  if (checks.has('pressure') && meter !== undefined) {
    const measured = meter.measure(session);
    result.pressure = {
      totalTokens: measured.totalTokens,
      surfaceTokens: measured.surfaceTokens,
      surfaceDeltaTokens: measured.surfaceDeltaTokens,
      logRevision: measured.logRevision
    };
  }
  return result;
}

function applyPlan(ctx, session, plan, selected, config, limit) {
  const wanted = selected === undefined ? null : new Set(selected.map(Number));
  let entries = wanted === null ? plan.entries : plan.entries.filter((entry) => wanted.has(entry.seq));
  if (Number.isSafeInteger(limit) && limit > 0) entries = entries.slice(0, limit);
  if (entries.length === 0) return { ok: true, applied: 0, message: '没有选中的条目' };

  // 主人要求：apply 的第一件实际动作是备份。
  let backupFile;
  try {
    backupFile = backupEntries(session, { ...plan, entries }, config);
  } catch (error) {
    log(`备份失败，停止折叠: ${String(error)}`);
    return { ok: false, code: 'BACKUP_FAILED', error: String(error) };
  }

  const surface = new Set(session.surface.nodes.map(Number));
  for (const entry of entries) {
    const span = Array.isArray(entry.span) && entry.span.length > 0 ? entry.span.map(Number) : [Number(entry.seq)];
    for (const seq of span) {
      if (!surface.has(seq)) {
        return { ok: false, code: 'PLAN_STALE', error: `seq ${seq} 已不在 surface 上，重新 plan`, backupFile };
      }
    }
    if (entry.kind === 'assistant-step') {
      if (hashSpan(session, span) !== entry.hash) {
        return { ok: false, code: 'PLAN_STALE', error: `span ${span[0]}..${span[span.length - 1]} 内容已变化，重新 plan`, backupFile };
      }
    } else {
      const event = session.eventAt(entry.seq);
      if (event === undefined || event.type !== 'user/message') {
        return { ok: false, code: 'PLAN_STALE', error: `seq ${entry.seq} 已不在 user/message surface 上，重新 plan`, backupFile };
      }
      const message = session.deriveEventMessage(event);
      if (message === null || hash32(`user/message:${textOf(message)}`) !== entry.hash) {
        return { ok: false, code: 'PLAN_STALE', error: `seq ${entry.seq} 内容已变化，重新 plan`, backupFile };
      }
    }
  }

  let applied = 0;
  let placeholders = 0;
  for (const entry of entries) {
    const span = Array.isArray(entry.span) && entry.span.length > 0 ? entry.span.map(Number) : [Number(entry.seq)];
    try {
      if (entry.kind === 'assistant-step') {
        const event = session.eventAt(entry.seq);
        const message = session.deriveEventMessage(event);
        const calls = (message?.content ?? []).filter((block) => block?.type === 'tool-call');
        const results = [];
        for (const seq of span.slice(1)) {
          const resultEvent = session.eventAt(seq);
          const resultMessage = session.deriveEventMessage(resultEvent);
          if (resultMessage !== null) results.push({ seq, message: resultMessage });
        }
        const summary = buildAssistantSummary({
          message,
          calls,
          results,
          hits: entry.hits ?? [],
          cleanedReasoning: (() => {
            const raw = (message?.content ?? [])
              .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n');
            return entry.clean === null || entry.clean === undefined ? raw : cleanRegexLines(raw, entry.clean);
          })(),
          rule: entry.summaryRule ?? {}
        });
        const text = summary.text?.trim() ? summary.text : EMPTY_SUMMARY_PLACEHOLDER;
        if (summary.empty || !summary.text?.trim()) placeholders += 1;
        session.append('user/message', {
          id: `context-fold-${entry.seq}-${Date.now()}`,
          role: 'user',
          source: { kind: 'plugin:context-fold' },
          content: [{ type: 'text', text }]
        }, {
          surfaceOp: { op: 'replace', startSeq: span[0], endSeq: span[span.length - 1] },
          sourceEventSeqs: span
        });
      } else {
        const event = session.eventAt(entry.seq);
        const message = session.deriveEventMessage(event);
        session.append('user/message', {
          ...message,
          source: safeReplacementSource(message),
          content: [{
            type: 'text',
            text: entry.replacement ?? `⟪context-fold⟫ 已折叠：${entry.ruleId}；原 seq ${entry.seq}，${entry.chars} 字符，原文备份在 ${backupFile}`
          }]
        }, {
          surfaceOp: { op: 'replace', startSeq: entry.seq, endSeq: entry.seq },
          sourceEventSeqs: [entry.seq]
        });
      }
      applied += 1;
    } catch (error) {
      log(`折叠 seq ${entry.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, placeholders, backupFile, requested: entries.length };
}

function backupEvent(session, seq, config, label) {
  const dir = path.join(config.backup.dir, String(session.id));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.jsonl`);
  const event = session.eventAt(seq);
  if (event === undefined) throw new Error(`event ${seq} not found`);
  fs.writeFileSync(file, `${JSON.stringify({ seq, event })}\n`, 'utf8');
  enforceCap(dir, config.backup);
  return file;
}

function rewriteReasoningStream(stream, newText, mode) {
  if (!Array.isArray(stream) || mode === 'keep') return stream;
  if (mode === 'drop') return stream.filter((record) => record?.type !== 'reasoning-chunks');
  const out = [];
  let replaced = false;
  for (const record of stream) {
    if (record?.type !== 'reasoning-chunks') { out.push(record); continue; }
    if (!replaced) {
      out.push({ ...record, texts: [newText], dt: [0] });
      replaced = true;
    }
  }
  return out;
}

function rewriteReasoningSource(message, mode) {
  if (mode === 'keep') return message.source;
  const source = { ...(message.source ?? {}) };
  const replay = source.replayState;
  if (replay === null || typeof replay !== 'object' || !Array.isArray(replay.blocks)) return source;
  let blocks = replay.blocks;
  if (mode === 'drop') blocks = blocks.filter((block) => block?.type !== 'reasoning');
  else if (mode === 'strip') blocks = blocks.map((block) => block?.type === 'reasoning' ? { type: 'reasoning' } : block);
  source.replayState = { ...replay, blocks };
  return source;
}

function editReasoning(session, seq, newText, options, config) {
  const target = Number(seq);
  if (!Number.isFinite(target)) return { ok: false, code: 'BAD_ARGS', error: 'seq 必须是数字' };
  if (typeof newText !== 'string') return { ok: false, code: 'BAD_ARGS', error: 'text 必须是字符串' };
  if (!session.surface.nodes.includes(target)) {
    return { ok: false, code: 'NOT_IN_SURFACE', error: `seq ${target} 不在当前 surface 上` };
  }
  const event = session.eventAt(target);
  if (event?.type !== 'assistant/message') {
    return { ok: false, code: 'NOT_ASSISTANT', error: `seq ${target} 不是 assistant/message` };
  }
  const message = session.deriveEventMessage(event);
  if (message === null || !Array.isArray(message.content)) {
    return { ok: false, code: 'NO_MESSAGE', error: '无法派生消息' };
  }
  const reasoningIndex = message.content.findIndex((block) => block?.type === 'reasoning');
  if (reasoningIndex < 0) {
    return { ok: false, code: 'NO_REASONING', error: `seq ${target} 没有 reasoning block` };
  }
  const hasToolCall = message.content.some((block) => block?.type === 'tool-call');
  const backupFile = backupEvent(session, target, config, `edit-reasoning-${target}-${Date.now()}`);
  const content = message.content.map((block, index) => index === reasoningIndex ? { ...block, text: newText } : block);
  const nextSource = rewriteReasoningSource(message, options.signatureMode ?? 'keep');
  const nextMessage = { ...message, content, source: nextSource };
  const nextData = {
    ...event.data,
    message: nextMessage,
    stream: rewriteReasoningStream(event.data.stream, newText, options.streamMode ?? 'keep')
  };
  try {
    session.append('assistant/message', nextData, {
      surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
      sourceEventSeqs: [target]
    });
    log(`edit_reasoning seq ${target} 成功（stream=${options.streamMode ?? 'keep'} signature=${options.signatureMode ?? 'keep'}）`);
    return {
      ok: true,
      edited: target,
      hadToolCall: hasToolCall,
      streamMode: options.streamMode ?? 'keep',
      signatureMode: options.signatureMode ?? 'keep',
      backupFile
    };
  } catch (error) {
    return { ok: false, code: 'EDIT_FAILED', error: String(error), backupFile };
  }
}

function sanitizeSummaryText(text) {
  if (typeof text !== 'string' || !text.includes('【已移除】')) return null;
  if (text.includes('已移除退化行')) return null;
  return text.replace(/【已移除】[\s\S]*$/u, '【已移除】\n已移除退化行（具体内容见本地日志/备份）。');
}

function collectSummaryTargets(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'plugin:context-fold') continue;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const sanitized = sanitizeSummaryText(text);
    if (sanitized === null) continue;
    out.push({ seq: Number(seq), event, message, text, sanitized });
  }
  return out;
}

function sanitizeSummaries(session, config, limit = 1000) {
  const targets = collectSummaryTargets(session).slice(0, limit);
  if (targets.length === 0) return { ok: true, applied: 0, targets: 0 };
  const planId = `sanitize-${Date.now().toString(36)}`;
  const backupFile = backupEntries(session, {
    planId,
    entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
  }, config);
  let applied = 0;
  for (const target of targets) {
    try {
      session.append('user/message', {
        ...target.message,
        source: safeReplacementSource(target.message),
        content: [{ type: 'text', text: target.sanitized }]
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq]
      });
      applied += 1;
    } catch (error) {
      log(`清洗旧摘要 seq ${target.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, targets: targets.length, backupFile, planId };
}

function backfillSummaryText(text) {
  if (typeof text !== 'string' || !text.includes('⟪context-fold⟫')) return null;
  let out = text
    .replace(/不是用户发言。/g, '不是用户发言')
    .replace(/按(?:我)?自己?定的判据/g, '按约定')
    .replace(/按热记忆判据/g, '按约定')
    .replace(/同一个词或短语连续出现两次/g, '明显重复时')
    .replace(/同一个单字连续出现两次/g, '明显重复时')
    .replace(/单字句/g, '短句')
    .replace(/机械重复/g, '重复')
    .replace(/判据/g, '约定');
  out = out.split(/\r?\n/).filter((line) => !/^[\u4e00-\u9fff]。$/.test(line)).join('\n');
  return out === text ? null : out;
}

function collectBackfillTargets(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'plugin:context-fold') continue;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const sanitized = backfillSummaryText(text);
    if (sanitized === null) continue;
    out.push({ seq: Number(seq), event, message, text, sanitized });
  }
  return out;
}

function backfillSummaries(session, config, limit = 1000) {
  const targets = collectBackfillTargets(session).slice(0, limit);
  if (targets.length === 0) return { ok: true, applied: 0, targets: 0 };
  const planId = `backfill-summaries-${Date.now().toString(36)}`;
  const backupFile = backupEntries(session, {
    planId,
    entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
  }, config);
  let applied = 0;
  for (const target of targets) {
    try {
      session.append('user/message', {
        ...target.message,
        source: safeReplacementSource(target.message),
        content: [{ type: 'text', text: target.sanitized }]
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq]
      });
      applied += 1;
    } catch (error) {
      log(`回填摘要 seq ${target.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, targets: targets.length, backupFile, planId };
}

function loadPairList(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  let seq = null;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const heading = line.match(/^## .*?seq\s+(\d+)/);
    if (heading) seq = Number(heading[1]);
    const pair = line.match(/^- pair：`(.+?)`/);
    if (pair && seq !== null) {
      if (!map.has(seq)) map.set(seq, new Set());
      map.get(seq).add(pair[1]);
    }
  }
  return map;
}

function cleanCdSummaries(session, config) {
  const files = config.cdPairFiles ?? [
    'E:\\小鲸的日常\\开发文档\\context-fold-pairs-v2-C.md',
    'E:\\小鲸的日常\\开发文档\\context-fold-pairs-v2-D.md'
  ];
  const pairs = new Map();
  for (const file of files) {
    for (const [seq, set] of loadPairList(file)) {
      if (!pairs.has(seq)) pairs.set(seq, new Set());
      for (const pair of set) pairs.get(seq).add(pair);
    }
  }
  const targets = [];
  const remaining = [];
  const restRe = /[。！？，、；：]([好嗯短做说加读写答试认])[。，]/g;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'plugin:context-fold') continue;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    let next = text;
    for (const pair of pairs.get(Number(seq)) ?? []) next = next.split(pair).join('');
    const start = next.indexOf('【清理后思考】');
    const end = next.indexOf('【助理原文】', start + 1);
    if (start >= 0 && end > start) {
      let reasoning = next.slice(start, end);
      reasoning = reasoning.replace(/([。！？，、；：])嗯[。，]/g, '$1');
      reasoning = reasoning.replace(/(^|\s)嗯[。，]/gm, '$1');
      const highFreqResiduals = [
        '嗯，短。', '好。短。', '好，加。', '好，认。', '好，读。',
        '好，写。', '好，答。', '好，试。', '好，说。', '好。短，'
      ];
      for (const residual of highFreqResiduals) {
        const escaped = residual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        reasoning = reasoning.replace(new RegExp(`[。！？，、；：]?${escaped}`, 'g'), '');
      }
      for (const match of reasoning.matchAll(restRe)) {
        const at = match.index ?? 0;
        remaining.push({
          seq: Number(seq),
          snippet: reasoning.slice(Math.max(0, at - 5), at + match[0].length + 5).replace(/\s+/g, ' ')
        });
      }
      next = next.slice(0, start) + reasoning + next.slice(end);
    }
    if (next !== text) targets.push({ seq: Number(seq), event, message, text, sanitized: next });
  }
  let backupFile = null;
  let planId = null;
  if (targets.length > 0) {
    planId = `clean-cd-${Date.now().toString(36)}`;
    backupFile = backupEntries(session, {
      planId,
      entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
    }, config);
    for (const target of targets) {
      try {
        session.append('user/message', {
          ...target.message,
          source: safeReplacementSource(target.message),
          content: [{ type: 'text', text: target.sanitized }]
        }, {
          surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
          sourceEventSeqs: [target.seq]
        });
      } catch (error) {
        log(`清理 C/D 摘要 seq ${target.seq} 失败: ${String(error)}`);
      }
    }
  }
  const reportPath = config.reasoningReportPath ?? 'E:\\小鲸的日常\\开发文档\\context-fold-reasoning-remaining-20261115-v2.md';
  const report = [
    '# 【清理后思考】剩余退化字组合（前后各 5 字）',
    '',
    `C/D 清理目标：${targets.length} 条`,
    `剩余命中：${remaining.length} 条`,
    ''
  ];
  for (const item of remaining) report.push(`- seq ${item.seq}：\`${item.snippet}\``);
  try { fs.writeFileSync(reportPath, report.join('\n'), 'utf8'); } catch (error) { log(`写报告失败: ${String(error)}`); }
  return { ok: true, targets: targets.length, remaining: remaining.length, backupFile, planId, reportPath };
}

function restoreSummariesFromMap(session, config) {
  const file = config.restoreMapFile ?? 'E:\\小鲸的日常\\开发文档\\restore-symbol-map-20261115.json';
  if (!fs.existsSync(file)) return { ok: false, code: 'MAP_NOT_FOUND', error: file };
  const map = JSON.parse(fs.readFileSync(file, 'utf8'));
  const targets = [];
  for (const [key, text] of Object.entries(map)) {
    const seq = Number(key);
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'plugin:context-fold') continue;
    const message = session.deriveEventMessage(event);
    targets.push({ seq, event, message, text });
  }
  if (targets.length === 0) return { ok: true, applied: 0, targets: 0 };
  const planId = `restore-symbols-${Date.now().toString(36)}`;
  const backupFile = backupEntries(session, {
    planId,
    entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
  }, config);
  let applied = 0;
  for (const target of targets) {
    try {
      session.append('user/message', {
        ...target.message,
        source: safeReplacementSource(target.message),
        content: [{ type: 'text', text: target.text }]
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq]
      });
      applied += 1;
    } catch (error) {
      log(`还原摘要符号 seq ${target.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, targets: targets.length, backupFile, planId };
}

function cleanResidualReasoning(session, config) {
  const re = /([。！？，、；：])([好嗯短做说加读写答试认])[。，]/g;
  const targets = [];
  const remaining = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'plugin:context-fold') continue;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const start = text.indexOf('【清理后思考】');
    const end = text.indexOf('【助理原文】', start + 1);
    if (start < 0 || end <= start) continue;
    let reasoning = text.slice(start, end);
    const cleaned = reasoning.replace(re, '$1')
      .replace(/：短，/g, '：')
      .replace(/：认。/g, '：');
    if (cleaned !== reasoning) {
      const next = text.slice(0, start) + cleaned + text.slice(end);
      targets.push({ seq: Number(seq), event, message, text, sanitized: next });
    }
    for (const match of cleaned.matchAll(re)) {
      const at = match.index ?? 0;
      remaining.push({ seq: Number(seq), snippet: cleaned.slice(Math.max(0, at - 5), at + match[0].length + 5).replace(/\s+/g, ' ') });
    }
  }
  let backupFile = null;
  let planId = null;
  if (targets.length > 0) {
    planId = `clean-residual-${Date.now().toString(36)}`;
    backupFile = backupEntries(session, {
      planId,
      entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
    }, config);
    for (const target of targets) {
      try {
        session.append('user/message', {
          ...target.message,
          source: safeReplacementSource(target.message),
          content: [{ type: 'text', text: target.sanitized }]
        }, {
          surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
          sourceEventSeqs: [target.seq]
        });
      } catch (error) {
        log(`清理剩余组合 seq ${target.seq} 失败: ${String(error)}`);
      }
    }
  }
  const reportPath = 'E:\\小鲸的日常\\开发文档\\context-fold-reasoning-remaining-20261115-v4.md';
  const report = ['# 清理剩余 54 条后的报告（前后各 5 字）', '', `修改摘要：${targets.length} 条`, `剩余命中：${remaining.length} 条`, ''];
  for (const item of remaining) report.push(`- seq ${item.seq}：\`${item.snippet}\``);
  try { fs.writeFileSync(reportPath, report.join('\n'), 'utf8'); } catch (error) { log(`写报告失败: ${String(error)}`); }
  return { ok: true, targets: targets.length, remaining: remaining.length, backupFile, planId, reportPath };
}

export function safeReplacementSource(message) {
  const source = message?.source;
  if (source?.kind === 'compact-checkpoint') {
    return { kind: 'plugin:context-fold' };
  }
  return source;
}

function sanitizeCompactionText(text) {  let out = text;
  out = out.replace(/^- \*\*`dsh-no-loop`\*\*.*$/gm,
    '- **`dsh-no-loop`** — injects a generic thinking-discipline rule (no literal example characters).');
  out = out.replace(/^- \*\*Thinking degeneration.*$/gm,
    '- **Thinking degeneration (major, tonight)** — reasoning collapsed into repeating a single character; fixed with thinking-guard + dsh-no-loop + hot-memory rule. Details in local logs.');
  out = out.replace(/^- \*\*Thinking-discipline entry now reads\*\*.*$/gm,
    '- **Thinking-discipline entry now reads**: a generic rule: stop when the same character repeats; explicitly not a length cap.');
  return out;
}

function sanitizeMemoryText(text) {
  let changed = false;
  const out = text.split(/\r?\n/).map((line) => {
    if (line.includes('第二个「好') || line.includes('943') || line.includes('复读几乎总是')) {
      changed = true;
      return '**长庚：思考里同一个单字连续出现两次，就立刻停止思考、直接动手。**（2026-11-13 立，2026-11-15 改为不写例字）';
    }
    return line;
  });
  return changed ? out.join('\n') : null;
}

function collectMemoryTargets(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'dsh-mnemon' || source.form !== 'memory-snapshot') continue;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const sanitized = sanitizeMemoryText(text);
    if (sanitized === null) continue;
    out.push({ seq: Number(seq), event, message, text, sanitized });
  }
  return out;
}

function sanitizeMemorySnapshots(session, config, limit = 1000) {
  const targets = collectMemoryTargets(session).slice(0, limit);
  if (targets.length === 0) return { ok: true, applied: 0, targets: 0 };
  const planId = `sanitize-memory-${Date.now().toString(36)}`;
  const backupFile = backupEntries(session, {
    planId,
    entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
  }, config);
  let applied = 0;
  for (const target of targets) {
    try {
      session.append('user/message', {
        ...target.message,
        source: safeReplacementSource(target.message),
        content: [{ type: 'text', text: target.sanitized }]
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq]
      });
      applied += 1;
    } catch (error) {
      log(`清洗热记忆快照 seq ${target.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, targets: targets.length, backupFile, planId };
}

function sanitizeThinkingNoteText(text) {
  if (typeof text !== 'string' || !text.includes('上一步的思考退化成了复读')) return null;
  return text.replace(
    /^⟪thinking-guard⟫ 上一步的思考退化成了复读（「[^」]*」×\d+，占该段 \d+%），/m,
    '⟪thinking-guard⟫ 上一步的思考已判为退化，'
  );
}

function collectThinkingNoteTargets(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    if (source.kind !== 'plugin:thinking-guard') continue;
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    const sanitized = sanitizeThinkingNoteText(text);
    if (sanitized === null || sanitized === text) continue;
    out.push({ seq: Number(seq), event, message, text, sanitized });
  }
  return out;
}

function sanitizeThinkingNotes(session, config, limit = 1000) {
  const targets = collectThinkingNoteTargets(session).slice(0, limit);
  if (targets.length === 0) return { ok: true, applied: 0, targets: 0 };
  const planId = `sanitize-thinking-${Date.now().toString(36)}`;
  const backupFile = backupEntries(session, {
    planId,
    entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
  }, config);
  let applied = 0;
  for (const target of targets) {
    try {
      session.append('user/message', {
        ...target.message,
        source: safeReplacementSource(target.message),
        content: [{ type: 'text', text: target.sanitized }]
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq]
      });
      applied += 1;
    } catch (error) {
      log(`清洗 thinking-guard 说明 seq ${target.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, targets: targets.length, backupFile, planId };
}

function sanitizeRuntimeText(text) {
  if (typeof text !== 'string') return null;
  const out = text
    .replace(/具体判据：\*\*思考里出现第二个「好。」就立刻停止思考、直接动手。\*\*/g,
      '具体判据：**出现明显的机械重复就立刻停止，直接动手。**')
    .replace(/同一个单字连续出现两次/g, '同一个词或短语连续出现两次')
    .replace(/第二个「好。」/g, '明显的机械重复');
  return out === text ? null : out;
}

function sanitizeRiskySummaryText(text) {
  if (typeof text !== 'string') return null;
  if (!text.includes('943') && !text.includes('第二个「好') && !text.includes('「好。」') && !text.includes('复读') && !text.includes('单字')) return null;
  const out = text
    .replace(/按热记忆判据：\*\*思考里出现第二个「好。」就停。\*\*/g,
      '按热记忆判据：出现明显机械重复就停。')
    .replace(/单字/g, '词或短语')
    .replace(/第二个「好。」/g, '明显的机械重复')
    .replace(/第二个「好」/g, '明显的机械重复')
    .replace(/「好。」/g, '单字句')
    .replace(/「好」/g, '单字句')
    .replace(/943/g, '很多次')
    .replace(/复读/g, '机械重复');
  return out === text ? null : out;
}

function collectPrimerTargets(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message') continue;
    const source = event.data?.source ?? {};
    const message = session.deriveEventMessage(event);
    const text = textOf(message);
    let sanitized = null;
    if (source.kind === 'runtime-context') sanitized = sanitizeRuntimeText(text);
    else if (source.kind === 'plugin:context-fold' || source.kind === 'schedule') sanitized = sanitizeRiskySummaryText(text);
    if (sanitized === null || sanitized === text) continue;
    out.push({ seq: Number(seq), event, message, text, sanitized, kind: source.kind });
  }
  return out;
}

function sanitizePrimers(session, config, limit = 1000) {
  const targets = collectPrimerTargets(session).slice(0, limit);
  if (targets.length === 0) return { ok: true, applied: 0, targets: 0 };
  const planId = `sanitize-primers-${Date.now().toString(36)}`;
  const backupFile = backupEntries(session, {
    planId,
    entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
  }, config);
  let applied = 0;
  for (const target of targets) {
    try {
      session.append('user/message', {
        ...target.message,
        source: safeReplacementSource(target.message),
        content: [{ type: 'text', text: target.sanitized }]
      }, {
        surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
        sourceEventSeqs: [target.seq]
      });
      applied += 1;
    } catch (error) {
      log(`清洗 primer seq ${target.seq} 失败: ${String(error)}`);
    }
  }
  return { ok: true, applied, targets: targets.length, backupFile, planId };
}

export function apply(ctx, rawConfig = {}) {
  const config = deepMerge(DEFAULTS, rawConfig ?? {});
  const state = {
    lastThreshold: new Map(),
    plans: new Map(),
    approved: new Set(),
    lastPlan: null
  };

  const targetSession = () => {
    if (config.targetSession) return ctx.get('sessions')?.get(config.targetSession) ?? null;
    const agent = ctx.get('agents')?.currentInitiator?.();
    return agent?.session ?? null;
  };

  async function triggerFor(agent) {
    if (config.trigger?.enabled === false) return;
    const session = agent?.session;
    if (session === undefined) return;
    if (config.targetSession && String(session.id) !== config.targetSession) return;
    const meter = ctx.get('tokenMeter');
    if (meter === undefined) return;
    const pressure = meter.contextPressure(session);
    const used = Number(pressure?.pressureTokens ?? NaN);
    const window = Number(pressure?.contextWindow ?? NaN);
    if (!Number.isFinite(used) || !Number.isFinite(window) || window <= 0) return;
    const ratio = used / window;
    const thresholds = [...(config.trigger.thresholds ?? [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const last = state.lastThreshold.get(String(session.id)) ?? -1;
    const threshold = thresholds.find((value) => value > last && ratio >= value);
    if (threshold === undefined) return;
    let loaded;
    try {
      loaded = loadRules(config, threshold, null);
    } catch (error) {
      state.lastThreshold.set(String(session.id), threshold);
      log(`阈值 ${threshold} 未找到规则: ${String(error)}`);
      return;
    }
    const plan = buildPlan(session, loaded.rules, config, { threshold, ruleFile: loaded.file });
    state.lastThreshold.set(String(session.id), threshold);
    state.lastPlan = plan;
    if (plan.entries.length === 0) {
      const kinds = new Map();
      for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (event?.type !== 'user/message') continue;
        const message = session.deriveEventMessage(event);
        const source = sourceOf(message);
        const key = `${source.kind ?? '?'}/${source.form ?? '?'}`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      log(`阈值 ${threshold} 触发，但没有匹配条目（${loaded.file}）；surface=${session.surface.nodes.length} user来源=${JSON.stringify([...kinds.entries()].slice(0, 12))}`);
      return;
    }
    state.plans.set(plan.planId, plan);
    state.approved.add(plan.planId);
    const report = writePlanReport(plan);
    log(`阈值 ${threshold} 触发：${plan.entries.length} 条，${plan.estimatedChars} 字符，plan=${plan.planId}，report=${report}`);
    if (config.mode === 'apply' && config.preview.autoApprove === true && config.preview.requireApproval !== true) {
      const result = applyPlan(ctx, session, plan, undefined, config);
      log(`自动 apply ${plan.planId}: ${JSON.stringify(result)}`);
    }
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      await triggerFor(agent);
    } catch (error) {
      log(`触发失败（不影响本步）: ${String(error)}`);
    }
    return next();
  }, { prepend: true });

  const tool = {
    name: 'context_fold',
    description: '按压力阈值/规则文档折叠模型可见上下文。action=plan 只出清单；approve 批准；apply 执行（先备份再替换）；status 查看最近计划。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'approve', 'apply', 'measure', 'estimate', 'estimate_plan', 'scan_range', 'scan_primers', 'scan_patterns', 'scan_pairs', 'sanitize_summaries', 'sanitize_memory_snapshots', 'sanitize_thinking_notes', 'status', 'plan_qq_injections', 'apply_qq_injections', 'plan_markers', 'apply_markers', 'health'] },
        sessionId: { type: 'string', description: 'QQ 注入清理 / 标记清理 / 体检：目标会话 ID；不传用 targetSession' },
        rules: { type: 'array', items: { type: 'object' }, description: '标记清理规则；不传使用默认 aurabot/runtime 规则' },
        checks: { type: 'array', items: { type: 'string' }, description: 'health：degeneration / duplicates / prefix / markers / pressure' },
        sources: { type: 'array', items: { type: 'string' }, description: 'health：只检查这些来源，例如 aurabot、runtime-context/snapshot' },
        maxMessages: { type: 'number', description: 'health：最多检查最近多少条 surface 节点' },
        nearThreshold: { type: 'number', description: 'health：近重复相似度阈值' },
        seqs: { type: 'array', items: { type: 'number' }, description: 'estimate：要估 token 的 seq 列表' },
        planId: { type: 'string', description: 'plan 返回的计划 id' },
        selected: { type: 'array', items: { type: 'number' }, description: '只折这些 seq；不传=全选' },
        limit: { type: 'number', description: 'apply 时只折前 N 条（按 seq 升序）' },
        ruleFile: { type: 'string', description: '可选：指定规则文件（相对 ruleDir 或绝对路径）' },
        threshold: { type: 'number', description: '可选：plan 时使用的阈值标识' },
        approve: { type: 'boolean', description: 'apply 时显式确认' }
      },
      required: ['action'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args) {
      const session = targetSession();
      if (session === null || session === undefined) {
        return { ok: false, code: 'SESSION_NOT_FOUND', error: '找不到目标会话；检查 targetSession' };
      }
      const action = args?.action;
      if (action === 'scan_pairs') {
        const pairRe = /([\u4e00-\u9fff])[。！？，、；：]([\u4e00-\u9fff])[。！？，、；：]/g;
        const highFreq = new Set(['好', '发', '做', '嗯', '行', '写', '改', '跑', '对', '是']);
        const buckets = { A: 0, B: 0, C: 0, D: 0, E: 0 };
        const samples = { A: [], B: [], C: [], D: [], E: [] };
        let total = 0;
        for (const seq of session.surface.nodes) {
          const event = session.eventAt(seq);
          if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
          const message = session.deriveEventMessage(event);
          if (message === null) continue;
          const text = textOf(message);
          const matches = [...text.matchAll(pairRe)];
          if (matches.length === 0) continue;
          const perPair = new Map();
          for (const match of matches) perPair.set(match[0], (perPair.get(match[0]) ?? 0) + 1);
          const source = event.data?.source ?? { kind: event.type };
          const key = `${source.kind ?? event.type}${source.form ? `/${source.form}` : ''}`;
          for (const match of matches) {
            total += 1;
            const pair = match[0];
            const index = match.index ?? 0;
            const lineStartIndex = text.lastIndexOf('\n', index) + 1;
            const prefix = text.slice(lineStartIndex, index).trim();
            const around = text.slice(Math.max(0, index - 50), index + 80).replace(/\s+/g, ' ');
            const meta = /判据|单字|机械重复|退化|连续两次|复读|思考纪律/.test(around);
            const dialogue = /[：:]$/.test(prefix) || /(?:我|你|他)：$/.test(prefix);
            let bucket = 'E';
            if (pair.includes('喵')) bucket = 'A';
            else if (meta) bucket = 'C';
            else if (dialogue) bucket = 'B';
            else if (highFreq.has(match[1]) && highFreq.has(match[2])) bucket = 'D';
            else if ((perPair.get(pair) ?? 0) > 1) bucket = 'D';
            buckets[bucket] += 1;
            if (samples[bucket].length < 18) {
              samples[bucket].push({ seq: Number(seq), source: key, pair, lineStart: prefix === '', around });
            }
          }
        }
        return { ok: true, total, buckets, samples };
      }
      if (action === 'scan_patterns') {
        const pairRe = /([\u4e00-\u9fff])[。！？，、；：]([\u4e00-\u9fff])[。！？，、；：]/g;
        const singleRe = /([\u4e00-\u9fff])。/g;
        const pairBySource = {};
        const singleBySource = {};
        const pairSamples = [];
        const summarySamples = [];
        let pairTotal = 0;
        let singleTotal = 0;
        for (const seq of session.surface.nodes) {
          const event = session.eventAt(seq);
          if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
          const message = session.deriveEventMessage(event);
          if (message === null) continue;
          const text = textOf(message);
          const pairs = [...text.matchAll(pairRe)].map((match) => match[0]);
          const singles = [...text.matchAll(singleRe)].map((match) => match[1]);
          if (pairs.length === 0 && singles.length === 0) continue;
          const source = event.data?.source ?? { kind: event.type };
          const key = `${source.kind ?? event.type}${source.form ? `/${source.form}` : ''}`;
          if (pairs.length > 0) {
            pairBySource[key] = (pairBySource[key] ?? 0) + pairs.length;
            pairTotal += pairs.length;
            if (pairSamples.length < 30) {
              const at = text.indexOf(pairs[0]);
              pairSamples.push({ seq: Number(seq), source: key, count: pairs.length, sample: pairs.slice(0, 8), around: text.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ') });
            }
          }
          if (singles.length > 0) {
            singleBySource[key] = (singleBySource[key] ?? 0) + singles.length;
            singleTotal += singles.length;
            if (source.kind === 'plugin:context-fold' && summarySamples.length < 25) {
              summarySamples.push({ seq: Number(seq), count: singles.length, sample: singles.slice(0, 12), around: text.slice(0, 180).replace(/\s+/g, ' ') });
            }
          }
        }
        return { ok: true, surfaceNodes: session.surface.nodes.length, pairTotal, singleTotal, pairBySource, singleBySource, pairSamples, summarySamples };
      }
      if (action === 'scan_primers') {
        const single = /^[\u4e00-\u9fff]。$/;
        const keywords = ['单字', '复读', '退化', '第二个', '943', '好。', '重复出现'];
        const userBySource = {};
        const userHits = [];
        const riskyHits = [];
        const assistantHist = {};
        const assistantSamples = [];
        for (const seq of session.surface.nodes) {
          const event = session.eventAt(seq);
          if (event === undefined) continue;
          if (event.type === 'user/message' || event.type === 'system/message' || event.type === 'developer/message') {
            const message = session.deriveEventMessage(event);
            const text = textOf(message);
            const exact = text.split(/\r?\n/).filter((line) => single.test(line)).length;
            const found = keywords.filter((kw) => text.includes(kw));
            if (exact > 0 || found.length > 0) {
              const source = event.data?.source ?? { kind: event.type };
              const key = `${source.kind ?? event.type}${source.form ? `/${source.form}` : ''}`;
              userBySource[key] = (userBySource[key] ?? 0) + 1;
              if (userHits.length < 40) {
                userHits.push({ seq: Number(seq), type: event.type, source: key, exact, keywords: found, head: text.replace(/\s+/g, ' ').slice(0, 160) });
              }
              if (found.includes('943') || found.includes('第二个')) {
                riskyHits.push({ seq: Number(seq), source: key, keywords: found, head: text.replace(/\s+/g, ' ').slice(0, 240) });
              }
            }
          } else if (event.type === 'assistant/message') {
            const message = session.deriveEventMessage(event);
            const reasoning = textOf({ content: (message?.content ?? []).filter((block) => block?.type === 'reasoning') });
            const exact = reasoning.split(/\r?\n/).filter((line) => single.test(line)).length;
            if (exact > 0) {
              const bucket = exact >= 6 ? '6+' : String(exact);
              assistantHist[bucket] = (assistantHist[bucket] ?? 0) + 1;
              if (assistantSamples.length < 25) assistantSamples.push({ seq: Number(seq), lines: exact });
            }
          }
        }
        return { ok: true, surfaceNodes: session.surface.nodes.length, userBySource, userHits, riskyHits, assistantHist, assistantSamples };
      }
      if (action === 'sanitize_summaries') {
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? args.limit : 1000;
        const targets = collectSummaryTargets(session).slice(0, limit);
        if (args?.approve !== true) {
          return {
            ok: true,
            dryRun: true,
            targets: targets.length,
            sampleSeqs: targets.slice(0, 20).map((target) => target.seq),
            sampleBefore: targets[0]?.text?.slice(-300) ?? null,
            sampleAfter: targets[0]?.sanitized?.slice(-300) ?? null
          };
        }
        if (config.mode !== 'apply') {
          return { ok: false, code: 'DRY_RUN', error: '当前是 dry-run；先把 mode 改成 apply 再执行' };
        }
        if (targets.length === 0) return { ok: true, applied: 0, message: '没有需要清洗的旧摘要' };
        const planId = `sanitize-${Date.now().toString(36)}`;
        let backupFile;
        try {
          backupFile = backupEntries(session, {
            planId,
            entries: targets.map((target) => ({ seq: target.seq, span: [target.seq] }))
          }, config);
        } catch (error) {
          return { ok: false, code: 'BACKUP_FAILED', error: String(error) };
        }
        let applied = 0;
        for (const target of targets) {
          try {
            session.append('user/message', {
              ...target.message,
              source: safeReplacementSource(target.message),
              content: [{ type: 'text', text: target.sanitized }]
            }, {
              surfaceOp: { op: 'replace', startSeq: target.seq, endSeq: target.seq },
              sourceEventSeqs: [target.seq]
            });
            applied += 1;
          } catch (error) {
            log(`清洗旧摘要 seq ${target.seq} 失败: ${String(error)}`);
          }
        }
        return { ok: true, applied, targets: targets.length, backupFile, planId };
      }
      if (action === 'sanitize_memory_snapshots') {
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? args.limit : 1000;
        const targets = collectMemoryTargets(session).slice(0, limit);
        if (args?.approve !== true) {
          return {
            ok: true,
            dryRun: true,
            targets: targets.length,
            sampleSeqs: targets.slice(0, 20).map((target) => target.seq),
            sampleBefore: targets[0]?.text?.slice(-500) ?? null,
            sampleAfter: targets[0]?.sanitized?.slice(-500) ?? null
          };
        }
        if (config.mode !== 'apply') {
          return { ok: false, code: 'DRY_RUN', error: '当前是 dry-run；先把 mode 改成 apply 再执行' };
        }
        return sanitizeMemorySnapshots(session, config, limit);
      }
      if (action === 'sanitize_thinking_notes') {
        const limit = Number.isSafeInteger(args?.limit) && args.limit > 0 ? args.limit : 1000;
        const targets = collectThinkingNoteTargets(session).slice(0, limit);
        if (args?.approve !== true) {
          return {
            ok: true,
            dryRun: true,
            targets: targets.length,
            sampleSeqs: targets.slice(0, 20).map((target) => target.seq),
            sampleBefore: targets[0]?.text?.slice(0, 300) ?? null,
            sampleAfter: targets[0]?.sanitized?.slice(0, 300) ?? null
          };
        }
        if (config.mode !== 'apply') {
          return { ok: false, code: 'DRY_RUN', error: '当前是 dry-run；先把 mode 改成 apply 再执行' };
        }
        return sanitizeThinkingNotes(session, config, limit);
      }
      if (action === 'status') {
        return { ok: true, lastPlan: state.lastPlan, pending: [...state.plans.keys()] };
      }
      if (action === 'measure') {
        const meter = ctx.get('tokenMeter');
        if (meter === undefined) return { ok: false, code: 'NO_TOKEN_METER', error: 'tokenMeter 不可用' };
        const m = meter.measure(session);
        return {
          ok: true,
          totalTokens: m.totalTokens,
          surfaceTokens: m.surfaceTokens,
          surfaceDeltaTokens: m.surfaceDeltaTokens,
          logRevision: m.logRevision
        };
      }
      if (action === 'estimate') {
        const meter = ctx.get('tokenMeter');
        if (meter === undefined) return { ok: false, code: 'NO_TOKEN_METER', error: 'tokenMeter 不可用' };
        const seqs = Array.isArray(args?.seqs) ? args.seqs.map(Number).filter(Number.isFinite) : [];
        const details = [];
        let total = 0;
        for (const seq of seqs) {
          const event = session.eventAt(seq);
          if (event === undefined) { details.push({ seq, error: 'not-found' }); continue; }
          const message = session.deriveEventMessage(event);
          if (message === null) { details.push({ seq, error: 'no-message' }); continue; }
          const tokens = meter.estimateMessage(message);
          details.push({ seq, type: event.type, tokens });
          total += tokens;
        }
        return { ok: true, totalTokens: total, details };
      }
      if (action === 'estimate_plan') {
        const meter = ctx.get('tokenMeter');
        if (meter === undefined) return { ok: false, code: 'NO_TOKEN_METER', error: 'tokenMeter 不可用' };
        const planFile = path.join(PLAN_DIR, `${args?.planId}.json`);
        if (!fs.existsSync(planFile)) return { ok: false, code: 'PLAN_NOT_FOUND', error: planFile };
        const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        let beforeTokens = 0;
        let afterTokens = 0;
        let grow = 0;
        let shrink = 0;
        let skipped = 0;
        for (const entry of plan.entries ?? []) {
          if (entry.kind !== 'assistant-step') { skipped += 1; continue; }
          const span = Array.isArray(entry.span) ? entry.span : [entry.seq];
          let before = 0;
          for (const seq of span) {
            const event = session.eventAt(seq);
            if (event === undefined) { skipped += 1; before = null; break; }
            const message = session.deriveEventMessage(event);
            if (message === null) { skipped += 1; before = null; break; }
            before += meter.estimateMessage(message);
          }
          if (before === null) continue;
          const event = session.eventAt(entry.seq);
          const message = session.deriveEventMessage(event);
          if (message === null) { skipped += 1; continue; }
          const calls = (message?.content ?? []).filter((block) => block?.type === 'tool-call');
          const results = [];
          for (const seq of span.slice(1)) {
            const resultEvent = session.eventAt(seq);
            const resultMessage = session.deriveEventMessage(resultEvent);
            if (resultMessage !== null) results.push({ seq, message: resultMessage });
          }
          const rawReasoning = (message?.content ?? [])
            .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n');
          const cleanedReasoning = entry.clean === null || entry.clean === undefined
            ? rawReasoning
            : cleanRegexLines(rawReasoning, entry.clean);
          const summary = buildAssistantSummary({
            message,
            calls,
            results,
            hits: entry.hits ?? [],
            cleanedReasoning,
            rule: entry.summaryRule ?? {}
          });
          const after = meter.estimateMessage({ role: 'user', content: [{ type: 'text', text: summary.text }] });
          beforeTokens += before;
          afterTokens += after;
          const delta = after - before;
          if (delta > 0) grow += 1; else if (delta < 0) shrink += 1;
        }
        return {
          ok: true,
          planId: plan.planId,
          entries: plan.entries?.length ?? 0,
          skipped,
          beforeTokens,
          afterTokens,
          deltaTokens: afterTokens - beforeTokens,
          grow,
          shrink
        };
      }
      if (action === 'health') {
        const target = ctx.get('sessions')?.get(args?.sessionId ?? config.targetSession);
        if (target === null || target === undefined) {
          return { ok: false, code: 'SESSION_NOT_FOUND', error: String(args?.sessionId ?? config.targetSession) };
        }
        try {
          return { ...healthScan(target, { ...args, ctx }), sessionId: String(target.id) };
        } catch (error) {
          return { ok: false, code: 'HEALTH_FAILED', error: String(error) };
        }
      }
      if (action === 'plan_markers') {
        const target = ctx.get('sessions')?.get(args?.sessionId ?? config.targetSession);
        if (target === null || target === undefined) {
          return { ok: false, code: 'SESSION_NOT_FOUND', error: String(args?.sessionId ?? config.targetSession) };
        }
        let plan;
        try {
          plan = buildMarkerPlan(target, args?.rules);
        } catch (error) {
          return { ok: false, code: 'BAD_RULE', error: String(error) };
        }
        state.plans.set(plan.planId, plan);
        state.lastPlan = plan;
        return {
          ok: true,
          planId: plan.planId,
          entries: plan.entries.length,
          estimatedChars: plan.estimatedChars,
          byRule: plan.byRule,
          rules: plan.rules,
          sampleSeqs: plan.entries.slice(0, 12).map((entry) => entry.seq)
        };
      }
      if (action === 'apply_markers') {
        if (args?.approve !== true) {
          return { ok: false, code: 'NOT_APPROVED', error: 'apply_markers 需要 approve:true' };
        }
        const target = ctx.get('sessions')?.get(args?.sessionId ?? config.targetSession);
        if (target === null || target === undefined) {
          return { ok: false, code: 'SESSION_NOT_FOUND', error: String(args?.sessionId ?? config.targetSession) };
        }
        let plan;
        try {
          plan = buildMarkerPlan(target, args?.rules);
        } catch (error) {
          return { ok: false, code: 'BAD_RULE', error: String(error) };
        }
        const result = applyPlan(ctx, target, plan, undefined, config);
        return { ...result, planId: plan.planId, estimatedChars: plan.estimatedChars, byRule: plan.byRule };
      }
      if (action === 'plan_qq_injections') {
        const target = ctx.get('sessions')?.get(args?.sessionId ?? config.targetSession);
        if (target === null || target === undefined) {
          return { ok: false, code: 'SESSION_NOT_FOUND', error: String(args?.sessionId ?? config.targetSession) };
        }
        const plan = buildQqInjectionPlan(target);
        state.plans.set(plan.planId, plan);
        state.lastPlan = plan;
        return {
          ok: true,
          planId: plan.planId,
          entries: plan.entries.length,
          estimatedChars: plan.estimatedChars,
          kept: plan.kept,
          sampleSeqs: plan.entries.slice(0, 12).map((entry) => entry.seq),
          rules: [...new Set(plan.entries.map((entry) => entry.ruleId))]
        };
      }
      if (action === 'apply_qq_injections') {
        if (args?.approve !== true) {
          return { ok: false, code: 'NOT_APPROVED', error: 'apply_qq_injections 需要 approve:true' };
        }
        const target = ctx.get('sessions')?.get(args?.sessionId ?? config.targetSession);
        if (target === null || target === undefined) {
          return { ok: false, code: 'SESSION_NOT_FOUND', error: String(args?.sessionId ?? config.targetSession) };
        }
        const plan = buildQqInjectionPlan(target);
        const result = applyPlan(ctx, target, plan, undefined, config);
        return { ...result, planId: plan.planId, estimatedChars: plan.estimatedChars, kept: plan.kept };
      }
      if (action === 'plan') {
        let loaded;
        try {
          loaded = loadRules(config, args?.threshold ?? 0, args?.ruleFile ?? null);
        } catch (error) {
          return { ok: false, code: 'RULE_NOT_FOUND', error: String(error) };
        }
        const plan = buildPlan(session, loaded.rules, config, { threshold: args?.threshold ?? null, ruleFile: loaded.file });
        state.plans.set(plan.planId, plan);
        state.lastPlan = plan;
        const report = writePlanReport(plan);
        return {
          ok: true,
          planId: plan.planId,
          entries: plan.entries.length,
          estimatedChars: plan.estimatedChars,
          reportPath: report,
          ruleFile: loaded.file,
          sampleSeqs: plan.entries.slice(0, 20).map((entry) => entry.seq)
        };
      }
      if (action === 'scan_range') {
        let loaded;
        try {
          loaded = loadRules(config, args?.threshold ?? 0, args?.ruleFile ?? null);
        } catch (error) {
          return { ok: false, code: 'RULE_NOT_FOUND', error: String(error) };
        }
        const min = Number.isSafeInteger(args?.min) && args.min > 0 ? args.min : 3;
        const max = Number.isSafeInteger(args?.max) && args.max >= min ? args.max : 5;
        const rules = loaded.rules.map((rule) => (
          rule.target === 'assistant-step' && rule.type === 'regex'
            ? { ...rule, match: { ...(rule.match ?? {}), minMatches: min } }
            : rule
        ));
        const plan = buildPlan(session, rules, config, { threshold: args?.threshold ?? null, ruleFile: loaded.file });
        const rows = plan.entries
          .filter((entry) => entry.kind === 'assistant-step')
          .map((entry) => ({
            seq: entry.seq,
            lines: (entry.hits ?? []).reduce((sum, hit) => sum + (Number(hit.count) || 0), 0),
            chars: entry.chars ?? 0,
            spanChars: entry.spanChars ?? 0
          }));
        const inRange = rows.filter((row) => row.lines >= min && row.lines <= max);
        const histogram = new Map();
        for (const row of rows) histogram.set(row.lines, (histogram.get(row.lines) ?? 0) + 1);
        return {
          ok: true,
          min,
          max,
          totalCandidates: rows.length,
          count: inRange.length,
          chars: inRange.reduce((sum, row) => sum + row.chars, 0),
          sampleSeqs: inRange.slice(0, 30).map((row) => row.seq),
          histogram: [...histogram.entries()].sort((a, b) => a[0] - b[0])
        };
      }
      if (action === 'approve') {
        if (!args?.planId || !state.plans.has(args.planId)) return { ok: false, code: 'PLAN_NOT_FOUND', error: 'planId 不存在' };
        state.approved.add(args.planId);
        return { ok: true, approved: args.planId };
      }
      if (action === 'apply') {
        if (config.mode !== 'apply') {
          return { ok: false, code: 'DRY_RUN', error: '当前是 dry-run；先把 mode 改成 apply 再执行' };
        }
        const plan = state.plans.get(args?.planId) ?? state.lastPlan;
        if (plan === null || plan === undefined) return { ok: false, code: 'PLAN_NOT_FOUND', error: '没有可执行的 plan' };
        if (!state.approved.has(plan.planId) && args?.approve !== true) {
          return { ok: false, code: 'NOT_APPROVED', error: '先 approve，或 apply 时传 approve:true' };
        }
        const result = applyPlan(ctx, session, plan, args?.selected, config, args?.limit);
        state.approved.delete(plan.planId);
        return result;
      }
      return { ok: false, code: 'BAD_ACTION', error: `未知 action: ${action}` };
    }
  };
  ctx.effect(() => ctx.tools.register(tool), 'dsh-context-fold: context_fold');
  log(`已加载 target=${config.targetSession || '(当前会话)'} mode=${config.mode}`);

  if (config.sanitizeOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('sanitizeOnLoad: 找不到目标会话');
          return;
        }
        const result = sanitizeSummaries(target, config, 1000);
        log(`sanitizeOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`sanitizeOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.sanitizeCompactionOnLoad === true && Number.isSafeInteger(config.compactionSeq)) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('sanitizeCompactionOnLoad: 找不到目标会话');
          return;
        }
        const seq = Number(config.compactionSeq);
        if (!target.surface.nodes.map(Number).includes(seq)) {
          log(`sanitizeCompactionOnLoad: seq ${seq} 不在 surface 上`);
          return;
        }
        const event = target.eventAt(seq);
        const message = target.deriveEventMessage(event);
        if (message === null) {
          log(`sanitizeCompactionOnLoad: seq ${seq} 无法派生消息`);
          return;
        }
        const before = textOf(message);
        const after = sanitizeCompactionText(before);
        if (after === before) {
          log(`sanitizeCompactionOnLoad: seq ${seq} 无需修改`);
          return;
        }
        const planId = `sanitize-compaction-${Date.now().toString(36)}`;
        const backupFile = backupEntries(target, { planId, entries: [{ seq, span: [seq] }] }, config);
        target.append('user/message', {
          ...message,
          source: safeReplacementSource(message),
          content: [{ type: 'text', text: after }]
        }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq]
        });
        log(`sanitizeCompactionOnLoad: seq ${seq} 已替换，before=${before.length} after=${after.length} backup=${backupFile}`);
      } catch (error) {
        log(`sanitizeCompactionOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.sanitizeMemoryOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('sanitizeMemoryOnLoad: 找不到目标会话');
          return;
        }
        const result = sanitizeMemorySnapshots(target, config, 1000);
        log(`sanitizeMemoryOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`sanitizeMemoryOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.sanitizeThinkingOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('sanitizeThinkingOnLoad: 找不到目标会话');
          return;
        }
        const result = sanitizeThinkingNotes(target, config, 1000);
        log(`sanitizeThinkingOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`sanitizeThinkingOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.sanitizePrimersOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('sanitizePrimersOnLoad: 找不到目标会话');
          return;
        }
        const result = sanitizePrimers(target, config, 1000);
        log(`sanitizePrimersOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`sanitizePrimersOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.backfillSummariesOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('backfillSummariesOnLoad: 找不到目标会话');
          return;
        }
        const result = backfillSummaries(target, config, 1000);
        log(`backfillSummariesOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`backfillSummariesOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.cleanCdOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('cleanCdOnLoad: 找不到目标会话');
          return;
        }
        const result = cleanCdSummaries(target, config);
        log(`cleanCdOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`cleanCdOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.restoreSymbolsOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('restoreSymbolsOnLoad: 找不到目标会话');
          return;
        }
        const result = restoreSummariesFromMap(target, config);
        log(`restoreSymbolsOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`restoreSymbolsOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }

  if (config.cleanResidualOnLoad === true) {
    const attempt = (n) => {
      try {
        const target = config.targetSession ? ctx.get('sessions')?.get(config.targetSession) : null;
        if (target === null || target === undefined) {
          if (n < 5) { setTimeout(() => attempt(n + 1), 1000); return; }
          log('cleanResidualOnLoad: 找不到目标会话');
          return;
        }
        const result = cleanResidualReasoning(target, config);
        log(`cleanResidualOnLoad: ${JSON.stringify(result)}`);
      } catch (error) {
        log(`cleanResidualOnLoad 失败: ${String(error)}`);
      }
    };
    setTimeout(() => attempt(0), 1000);
  }
}

export { normalizeMarkerRules, buildMarkerPlan, buildQqInjectionPlan, healthScan };
