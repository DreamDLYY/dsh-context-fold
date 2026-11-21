# Third-party and runtime dependencies

This repository contains the `dsh-context-fold` plugin source only. It does not
vendor or redistribute third-party source code.

## Runtime

| Component | Role | Bundled? |
|---|---|---|
| DeepSeek Harness / Cordis host | Loads the plugin and provides the session, surface, tool, and token-meter APIs used by `lib/index.js` | No |
| Node.js built-in modules (`node:fs`, `node:path`, `node:os`, `node:url`) | Filesystem, path, and module URL handling | No (part of Node.js) |

The plugin calls host APIs through Cordis (`ctx.get('sessions')`,
`ctx.get('tokenMeter')`, `ctx.on(...)`, `ctx.tools.register(...)`) and does not
import a separate DSH package. Install and use it under the license and terms of
your DeepSeek Harness installation.

Node.js is required at `>=22.19.0` as declared in `package.json`.

## Development-time diagnostic tool

During development, `dsh-session-recover` (npm package; binary `dsh-recover`)
was used to inspect session files and workspace orphan state.

- It is **not** a runtime dependency.
- It is **not** imported by the plugin.
- It is **not** included in this repository.
- It remains a separate project; follow its own license and terms.

## Code provenance

- `lib/index.js`, `lib/detect.mjs`, and `lib/summary.mjs` are the implementation
  written for this project.
- `rules/*.yml` are example rules written for this project.
- `test/*` uses only Node.js built-ins and an in-memory fake session; it contains
  no real session data.
- No third-party source files are copied into this repository.

## Names and trademarks

“DeepSeek”, “DeepSeek Harness”, “Cordis”, and other product names are the
property of their respective owners. They are used only to describe
compatibility and integration.
