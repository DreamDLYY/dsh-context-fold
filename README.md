# dsh-context-fold

DeepSeek Harness 的会话上下文折叠插件，默认 **dry-run**，自动触发默认关闭。

> 这是个人工作流里长出来的工具，先把安全边界放在功能前面：
> 先备份、再替换；不删会话文件；默认不自动运行。

## 状态

| 项 | 值 |
|---|---|
| 版本 | 0.2.0 |
| 运行模式 | `dry-run` |
| 自动触发 | 默认关闭 |
| 需要 | Node.js >= 22.19 |
| 测试 | `npm test`（source-fix / markers / health / regex / QQ 注入） |

已实现：

- 按规则扫描会话 surface；
- `plan` / `approve` / `apply`；
- 压力 `measure`；
- 只读 `health` 体检（退化、重复、注入前缀、折叠标记、压力）；
- `plan_markers` / `apply_markers` 标记清理；
- `plan_qq_injections` / `apply_qq_injections`（QQ 注入去重，实验性）。

未实现：

- `unfold(foldId)` / `search_folded(query)`；
- 折叠原文的可检索归档；
- 自动触发默认策略（当前固定关闭）；
- 正则超时/灾难性回溯防护（当前只做编译、长度、flags 校验）。

## 安装

### 本地开发 / 本机使用

在 DSH 的 `plugin_manager` 中安装这个目录：

```text
plugin_manager
  action: install_bundle
  target: /absolute/path/to/dsh-context-fold
```

安装后确认：

```text
enabled: true
mode: dry-run
trigger.enabled: false
```

### 配置

`cordis.patch.yml` 里的以下值必须由使用者改成自己的路径：

```yaml
targetSession: ''
backup:
  dir: '/absolute/path/to/context-fold-backups'
trigger:
  ruleDir: './rules'
```

`ruleDir` 是相对路径时，会按插件目录解析到 `rules/`；  
`backup.dir` 仍按 DSH 进程的 cwd 解析，建议写绝对路径。

`targetSession` 留空时，使用工具参数指定会话：

```json
{ "action": "health", "sessionId": "session-..." }
```

不要把个人 session id、绝对路径、备份目录写进公开仓库。

## 工具动作

所有动作都挂在 `context_fold` 下。

| action | 作用 | 会改 surface |
|---|---|---|
| `plan` | 按规则生成折叠计划 | 否 |
| `approve` | 批准一个 plan | 否 |
| `apply` | 执行已批准计划 | 是 |
| `measure` | 查看 total/surface token | 否 |
| `estimate` | 估算指定 seq | 否 |
| `health` | 只读体检 | 否 |
| `plan_markers` | 生成折叠标记清理计划 | 否 |
| `apply_markers` | 执行标记清理，需要 `approve:true` | 是 |
| `plan_qq_injections` | 生成 QQ 注入去重计划 | 否 |
| `apply_qq_injections` | 执行 QQ 注入去重，需要 `approve:true` | 是 |
| `status` | 查看最近计划 | 否 |

### health

```json
{
  "action": "health",
  "sessionId": "session-...",
  "checks": ["degeneration", "duplicates", "prefix", "markers", "pressure"],
  "maxMessages": 5000,
  "nearThreshold": 0.95
}
```

返回：

```json
{
  "ok": true,
  "degeneration": { "messages": 1, "singleLines": 0, "pairs": 2 },
  "markers": { "aurabot": 413, "runtime": 370, "total": 783 },
  "prefix": { "messages": 92, "prefixChars": 31162, "bodyChars": 3930 },
  "duplicates": {},
  "pressure": { "totalTokens": 361418, "surfaceTokens": 210612 }
}
```

说明：

- `maxMessages` 默认 5000，最大 10000；
- 近重复只对不超过 120 条的分组计算，避免 O(n²)；
- `time-context` 默认不按相似度去重。

### markers

默认规则：

| 规则 | 匹配 | 替换 |
|---|---|---|
| `aurabot-marker` | 前缀 `【aurabot 记忆前言已折叠】` | 空字符串，去掉开头空行 |
| `runtime-marker` | 整条等于 `【runtime-context 已折叠】` | 单个空格 |

自定义规则：

```json
{
  "action": "plan_markers",
  "sessionId": "session-...",
  "rules": [
    {
      "id": "my-marker",
      "match": { "mode": "regex", "pattern": "【[^】]*已折叠】", "flags": "g" },
      "replace": " ",
      "hook": null
    }
  ]
}
```

支持：

```text
match.mode: exact | prefix | regex
match.pattern: 必填，最长 2000 字符
match.flags: g i m s u y
replace: 字符串
hook: 预留给后续命名钩子，当前不执行
```

非法正则会返回 `BAD_RULE`，不会生成计划，也不会改 surface。

### 备份与回滚

每次 `apply` 前会写：

```text
<backup.dir>/<sessionId>/<planId>.jsonl
```

同时建议在 apply 前自己做整份 `.zstd` 备份：

```powershell
Copy-Item <session>\session.v4.jsonl.zstd <backup>\session-before-fold.zstd
```

回滚：

1. 停止 DSH；
2. 用备份覆盖 `session.v4.jsonl.zstd`；
3. 重启 DSH。

不要在 DSH 运行时直接改会话文件。

## 安全边界

- 只处理 `user/message` 或 `assistant-step`，不会碰 `tool/result` 以外的未知类型；
- 默认不删除消息，只追加 replacement 节点；
- `apply_markers` / `apply_qq_injections` 绕过 `mode`，只靠 `approve:true`；
  公开使用前请确认你理解这一点；
- `replace` 正则由调用方提供，插件只做编译/长度/flags 校验，不做灾难性回溯防护；
- 没有附带任何真实会话、用户数据或密钥。

## 开发

```powershell
npm test
```

测试覆盖：

- `source-fix`：compact-checkpoint 替换不继承 `compactionId` / `sourceCommandId`；
- `markers`：默认标记、正文保留、自定义正则、幂等；
- `health`：退化、标记、前缀、重复、压力；
- `regex`：非法正则、空 pattern、非法 flags、超长 pattern；
- `qq-injections`：保留最新前缀/快照，保留正文。

测试使用 `test/fake-session.mjs` 的纯内存会话，不读取真实会话文件。

## License

MIT
