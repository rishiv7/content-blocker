# Short-form blocking — integration verification record

Sweep date: 2026-09-24 · Branch: `feat/short-form-integration` (release branch + #10 engine merged ff + #6 popup merged + release base 480c39a folded in) · Spec: approved blueprint `art_wy13pFy7`.

## Base-move fold (2026-09-24, post-initial sweep)

The release base moved: `480c39a` merged main's `e227ff1` (revert of the direct gpt-6-luna compiler) into the release branch, restoring the TrueForge compiler stack. The fold was merged into this branch and resolved with both intents kept: the revert's TrueForge state (README section, `compilerAgent` mock key, `test-openai.mjs` removed, localhost:8790 host permission) plus all short-form work and docs. One test baseline changed: the criterion-9 manifest guard now asserts the reverted host-permission set (`https://api.typesafe.ai/*`, `http://localhost:8790/*`) — its intent (the short-form work adds zero permissions) is unchanged. `extension/short-form.js` is byte-identical across the fold (sha256 `a1b190d5d5611d9389f7012f4eb1da7cb61633ba71079517cf68f10428950622`), so all live/fixture captures below describe the same engine bytes; they were re-attested against the resolved head.

## Suite

- Full suite on Node v22.14.0 (`node --test tests/*.test.js`) at the resolved head `154b279`: **84/84 passing**. The count moved 86 → 84 because the revert removed the two compiler-era test cases, not because of short-form work; all nine pre-existing files otherwise unmodified, plus `short-form-settings.test.js` (#4), `short-form-engine.test.js` (#10), and the popup round-trip additions in `ui.test.js` (#6).
- Environment note: the repo requires Node ≥ 22.14 (`engines`); under Node 20 the jsdom → undici import fails (`markAsUncloneable`), which is a toolchain mismatch, not a code failure. Verified both ways in the sweep sandbox.

## Integrated flow (popup toggle → broadcast → suppression)

The popup persists `shortForm` via `SAVE_SETTINGS`; the worker broadcasts `CONFIG_CHANGED`; the engine re-derives state. The live run below injects the engine verbatim (sha256 `a1b190d5…`) with a `chrome.runtime` stub standing in for the background worker at the same message boundary — the identical method used for PR #10's dogfood. Injection is post-load, so `document_start` paint timing is evidenced by the manifest registration, not by injection.

| Spec criterion | Result | Evidence |
| --- | --- | --- |
| 1 — `/shorts/<id>` hard load: no video, inert placeholder, chrome visible | LIVE PASS (youtube.com/shorts/ieNrYEu8L3M): page mode engaged, 2/2 videos paused + autoplay stripped, "Short-form video blocked" chip bottom-center, masthead `display: block`, guide visible | `tc-1-live-shorts-before.png`, `tc-1-live-shorts-after.png` |
| 2 — Shorts shelves suppressed, ordinary items untouched | LIVE PASS (search results): 51 matched containers collapsed to 24px chips; ordinary results render normally (href-anchored, title-only matches untouched) | `tc-2-live-search-before.png`, `tc-2-live-search-after.png` |
| 3 — SPA engage/disengage without reload | LIVE PASS: logo click `/shorts/<id>` → `/` clears page mode; `history.back()` re-engages it; window marker alive across both legs (no reload) | `tc-3-spa-home.png`, `tc-3-spa-back-shorts.png` |
| 4 — IG `/reels/` + FB `/reel/` pages and href-anchored feed items | IG LIVE PASS (media stop): live `/reels/<id>` guest route — page mode engaged, 4/4 videos paused, autoplay stripped; no feed markup exists in guest view, so item mode is fixture-verified. FB LIVE: login wall, no render — fixture-verified only | `tc-4b-instagram-live-before.png`, `tc-5-instagram-live-after.png`, `tc-5-facebook-live.png`, `tc-5-fixture-instagram.png`, `tc-5-fixture-facebook.png` |
| 5 — TikTok feed suppressed; video paused, autoplay stripped | LIVE: login/bot wall, no feed rendered — fixture-verified only (fail-visible) | `tc-5-tiktok-live.png`, `tc-5-fixture-tiktok.png` |
| 6 — Mode off → zero artifacts | LIVE PASS: after `CONFIG_CHANGED {shortForm:false}` — style element gone, both scope attributes null, chip gone, native `history.pushState` restored (`pushRestored: true`) | `tc-4-toggle-off-after.png` |
| 7 — `SET_SITE` keyless when short-form on; today's errors when off | PASS — `tests/short-form-settings.test.js` (merged with #4) | suite |
| 8 — `shortForm` validation + config broadcast | PASS — `tests/short-form-settings.test.js`, `tests/ui.test.js` round-trip | suite |
| 9 — No permission changes; manifest gains only the registration | PASS — full-branch diff `5e35c3a..HEAD` on `extension/manifest.json` is exactly the one `content_scripts` block; permissions/host_permissions/optional_host_permissions untouched by the short-form work (the revert's localhost:8790 baseline is asserted as-is); the only `declarativeNetRequest` string in the branch diff is the test asserting its absence | this record |

Fixture-rendered visuals (`tc-5-fixture-*.png`) apply the engine's `stylesheet()` output verbatim (extracted at `a1b190d5`) to synthetic DOM mirroring the test fixtures — clearly labeled, not presented as live-site captures. Fail-visible status: TikTok and Facebook SURFACES rows are marked unverified (2026-09-24); a selector miss on those surfaces hides nothing.

## Boundary invariant

The text pipeline is behaviorally unchanged: all nine pre-existing test files pass unmodified; short-form suppression sends no Jev request, requires no API key, and blocks no network request; `content.js` is untouched on this branch.

## Notes for the release

- Merge freeze (2026-09-24): nothing merges until Rishi's local test; promotion to `main` is his call. This PR and #6/#10 stay open.
- README updated on this branch: architecture subsection, Controls row, Limits paragraph (with the TikTok per-site overlap note), file table, and test-coverage sentence.
