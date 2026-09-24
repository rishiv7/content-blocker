# Codebase map — content-blocker

Folder-level overview (depth 2). Source of truth for behavior: `README.md`.

| Path | Purpose |
| --- | --- |
| `extension/` | The Chrome MV3 extension — load this folder unpacked in Chrome. |
| `extension/icons/` | Toolbar/extension icons (16/32/48/128 px). |
| `extension/vendor/` | Generated TrueForge SDK bundle + license (`npm run build`; tracked, do not hand-edit). |
| `scripts/` | Node tooling: SDK bundling and TrueForge agent management. |
| `tests/` | `node:test` suites — all mocked, no network or keys required. |
| `package.json` | Tooling manifest; scripts, engines (Node >=22.14.0), deps. |
| `package-lock.json` | npm lockfile (the repo's package manager is npm). |
| `README.md` | Product, install, and development docs — read before changing behavior. |

Key extension files:

| File | Role |
| --- | --- |
| `extension/manifest.json` | MV3 manifest (storage/activeTab/scripting; host perms for TypeSafe API and localhost:8790). |
| `extension/background.js` | Service worker: rules, compilation broker, API broker, caches, quotas, site registration. |
| `extension/compiler-agent.js` | Saved compiler agent spec: agent name, model, strict output schema, prompt. |
| `extension/rule-compiler.js` | TrueForge SDK session/stream integration, output validation, cancellation. |
| `extension/jev.js` | Jev classifier; builds the `should_block` question from the saved rule. |
| `extension/content.js` | Text discovery, page-memory scores, rule invalidation, cover overlays. |
| `extension/score-cache.js` | Persistent scores, batch lookup, pending-request sharing. |
| `extension/popup.html/.js/.css` | Instruction editor, per-site toggle, threshold, reveal controls. |
| `extension/options.html/.js` | TrueForge connection check, TypeSafe key management, enabled sites. |
| `extension/request-log.js`, `extension/logs.*` | Jev request logging and inspector UI. |

Test suites (all runnable via `npm test`): `background`, `cache`, `content`, `jev`, `log`, `rule-compiler`, `trueforge-background`, `tweet-cover`, `ui`.
