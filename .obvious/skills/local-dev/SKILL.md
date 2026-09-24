---
name: local-dev
description: How to get the content-blocker repo to a verified local dev state in the sandbox.
---

# Skill: local-dev (content-blocker)

Recorded by the 2026-09-24 onboarding run. Applies to this repo's sandbox checkout.

## Goal

Install deps, build the extension bundle, and run the full mocked test suite — the canonical local verification for this repo (there is no server and no browser in the sandbox).

## Environment facts

- `engines.node` is `>=22.14.0`, and jsdom 30.1.0 wants `^22.22.2 || ^24.15.0 || >=26`. The sandbox system node (20.20.2) is too old. A matching Node is installed at `~/.local/node22` (v22.23.3, tarball from nodejs.org):

  ```sh
  export PATH="$HOME/.local/node22/bin:$PATH"
  ```

- `node_modules` ships root-owned in the sandbox; plain `npm ci` fails with `EACCES` when it tries to prune. Fix: `sudo rm -rf node_modules` once, then `npm ci`.
- Registry access works; no proxy tweaks needed. `npm ci` installs 40 packages in ~3 s.
- No Chrome/Chromium binary exists in the sandbox, and no TrueForge server runs at `localhost:8790`. Both are outside what this repo can provision; the README explicitly leaves browser validation to the user.

## Verified procedure

```sh
export PATH="$HOME/.local/node22/bin:$PATH"
[ -d node_modules ] || npm ci          # add `sudo rm -rf node_modules &&` first if EACCES
npm run build                          # rebuilds extension/vendor/trueforge-sdk.js
npm test                               # node --test tests/*.test.js
node --check extension/*.js            # optional syntax sweep of loadable extension code
```

## Evidence from the 2026-09-24 run

- `npm ci`: OK (40 packages).
- `npm run build`: OK; the tracked `extension/vendor/trueforge-sdk.js` stayed byte-identical after rebuild.
- `npm test`: 63 pass / 0 fail / 0 skipped, ~1.5 s. No API keys, no TrueForge server, no network needed.
- `node --check` on all 11 `extension/*.js` files: OK. `extension/manifest.json`: valid JSON.

## Caveats

- `npm run test:live` and `npm run setup:trueforge` require a running TrueForge server (`http://localhost:8790`) with a configured model — skip them unless that service exists; they are explicitly optional in the README.
- `bun.lock` in the sandbox is untracked; npm is the package manager (only `package-lock.json` is tracked).
- If `npm run build` ever produces a diff in `extension/vendor/`, investigate before committing — the tracked bundle should be reproducible.
