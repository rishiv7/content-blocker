# Content Blocker

A Chrome extension that filters page text using one personal instruction. Write **“No travel-related content, but allow local news”** in the popup. A local TrueForge agent translates your preference into a classification rule, and Jev evaluates passages against that rule. Matching text receives a white cover that you can click to reveal. A flagged tweet gets one cover over its entire article, including attached images; revealing it shows the text and images together.

This replaces the previous fixed AI-slop classifier. Nothing is filtered until you save an instruction and enable a site. To block AI-style filler, describe that preference in your instruction.

## Install and set up

1. Unzip the extension download, or clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the **`extension` folder** containing `manifest.json`.
4. Open **Content Blocker → Settings**. Enter your **TypeSafe API key**, then save. Keep TrueForge running at `http://localhost:8790`, with its model provider configured and the compiler agent installed (see below). Existing TypeSafe keys and site settings are retained when updating the same installation.
5. Open the popup, enter your instruction, and select **Save & apply**. The active-filter summary describes the generated rule.
6. Visit a site and turn on **Filter this site** in the popup. Chrome requests access to that site.

The model key is configured in TrueForge, not the extension. The extension calls the local TrueForge server through the bundled official SDK. The TypeSafe key is used for Jev content evaluations. A blank key field preserves its saved key; use **Remove saved TypeSafe key** to delete it. A legacy OpenAI key from v2.0 is no longer read or used by this extension.

When updating, replace the files in the folder Chrome already loads, click **Reload** in `chrome://extensions`, and refresh website tabs. Version 2.1 replaces direct OpenAI access with `http://localhost:8790/*` for the local agent; approve Chrome's permission update if prompted. Upgrading from Slop Shield does not automatically carry forward AI-slop blocking: save your first custom instruction.

## Controls

| Control | Behavior |
| --- | --- |
| Your filter | One natural-language instruction, up to 2,000 characters, shared across enabled sites. |
| Save & apply | Compile with TrueForge and apply to enabled tabs. The previous rule stays active if compilation fails. Saving the unchanged active instruction reuses it. |
| Clear filter everywhere | Remove the active rule and covers. Site preferences remain saved; no agent request is needed. |
| Filter this site | Enable or disable the current website's origin. |
| Confidence threshold | Cover passages scoring at least this value; default 85/100. |
| White cover | Click, or keyboard-focus and activate, to reveal. A tweet cover reveals its text and attached images together. |
| Reveal all | Remove covers and pause this page until rescan, reload, or a new rule. |
| Rescan page | Reset the page's scan budget and reveal choices, reusing scores for the current rule. |
| Request log | Inspect Jev requests, responses, and individual cache/shared evaluation results. |

## How it works

```mermaid
flowchart TD
    Input[Save your instruction] --> TrueForge[TrueForge SDK runs the compiler agent]
    TrueForge --> Saved[Validate and save the rule]
    Saved --> Reset[Remove old covers and reset page scores]
    Page[Discover loaded page text] --> Memory{Score in page memory?}
    Memory -->|Yes| Threshold{Matches your threshold?}
    Memory -->|No| Cache[Look up persistent scores in batches]
    Cache -->|Hit| Threshold
    Cache -->|Miss| Jev[Jev evaluates text against your saved rule]
    Jev --> Persist[Validate and cache score]
    Persist --> Threshold
    Threshold -->|Yes| Cover[Inject a clickable white cover]
    Threshold -->|No| Visible[Leave content visible]
```

### Instruction compilation

Saving a new instruction uses `@truefoundry/trueforge-sdk` to create a fresh session on the saved **content-blocker-compiler** agent and stream one turn. Only the instruction is sent to TrueForge and its model provider. The final `turn.done` result must contain complete, non-refused JSON with exactly `summary`, `instructions`, `block`, and `allow`; field lengths are validated before the saved rule is replaced. Failed, malformed, interrupted, paused, refused, or timed-out runs keep the previous rule active. Cancelling an instruction also requests cancellation of the server-side turn.

The compiler defaults to the configured `openai/gpt-5-4-mini` model, reasoning effort `none`, an 800-token output cap, strict JSON schema, and one model iteration. Tools, sandbox, web search, subagents, user questions, generative UI, and compaction are disabled. The extension streams the result without polling, disables automatic SDK retries, and reuses the unchanged active instruction without a model call. Each changed instruction gets its own session so earlier preferences cannot contaminate its context. Existing v2.0 filters keep working; saving one again recompiles it through TrueForge.

Explicit allow exceptions override block topics, including when a passage matches both. For example, “no travel except local news” allows local travel news, while “only show cats” blocks content outside that topic. Jev receives the original preference and instructions to treat page content as untrusted, honor exceptions, and allow ambiguous passages. Model interpretation can still be wrong; review the summary and adjust the instruction as needed.

Live SDK smoke tests completed in approximately **1.5–2.1 seconds** on this machine. This is measured rule-compilation latency, not a guarantee or a Jev passage-evaluation benchmark.

Implementation reference: [TrueForge SDK quickstart](https://trueforge.dev/api/quickstart).

### Page classification and caching

The page script discovers eligible text throughout the mounted DOM, including off-screen content and every reachable open shadow root. Visible and nearby passages are prioritized. It never fetches unloaded tweets or calls a website's private API. Nested tweet text is kept together. A flagged tweet covers its enclosing article, so attached images (including images loaded later) are covered without extra API calls. Multiple flagged text passages in the same tweet share one cover and one reveal action. Generic page text retains passage-sized covers.

Page memory retains up to 10,000 recent text scores after their DOM nodes disappear. Returning tweets can receive covers without another background message. Persistent cache probes run in batches of 64 independently of slow Jev evaluations, and cache hits still work when the new-evaluation budget is exhausted or an API error has paused new requests.

Jev receives one passage and one question named `should_block`. The question changes with your saved instruction. A positive score means the text should be blocked. The background worker validates the result before saving it; failed evaluations are not cached.

Persistent scores are keyed by a SHA-256 hash of the complete Jev request: text, model, and compiled rule. Different rules cannot reuse each other's decisions. Changing a rule clears page-memory scores and old covers, cancels old network evaluations, and rejects stale requests. Old persistent scores can only be reused when the complete request matches. Threshold changes reuse scores without recompiling a rule.

## Data and permissions

| Information | Where it lives / where it goes |
| --- | --- |
| TypeSafe API key | Trusted extension local storage, not synced; used only by the background worker. |
| Model provider key | Managed by local TrueForge; never sent to or read by the extension. |
| Original instruction and compiled rule | Trusted local extension storage; the instruction goes to local TrueForge and its configured model provider when compiling, and the compiled rule accompanies Jev evaluations. |
| Eligible page text | Goes to TypeSafe for uncached evaluations on enabled sites, including off-screen text already loaded. Not sent to the TrueForge compiler or its model provider by this extension. |
| Compilation sessions | TrueForge stores instructions and generated rules in its local SQLite database; inspect them in TrueForge Sessions. Provider retention follows the provider configuration. |
| Recent text and scores | Page memory, up to 10,000 scores; reset on reload or rule change. |
| Passage fingerprints and scores | Local extension storage, up to 10,000 entries across reloads and browser restarts. |
| Jev request log | Trusted extension session storage, latest 100 events, cleared on browser restart or extension reload. |

API payloads do not include page URLs, cookies, or form-field values. Passage text can still contain private information. Forms, editable areas, navigation, code, and hidden elements are excluded on a best-effort basis. The extension adds no encryption to locally stored keys and has no analytics or automatic log uploads.

Filtering is off on a website until enabled. Disabling a site removes its automatic script registration; its Chrome host permission remains available for re-enabling unless revoked separately in Chrome.

## Request log

The inspector records Jev request bodies (including your rule), response bodies, scores, status codes, timing, errors, and individual cache/shared results. TrueForge compilation, batch cache probes, and page-memory reuse are not logged individually. Logs contain passage text and site origins locally; exports contain those details. Authorization headers are excluded and the active TypeSafe key is redacted from logged data.

Recording can be paused or cleared independently of cached classification scores. Response previews are limited to 16 KB. In-flight requests may finish updating existing events after recording is paused.

## Limits

- Filtering decisions use **text passages**. On X/Twitter, a flagged tweet’s entire article is covered, including attached images and other media. Image-only tweets are not independently classified. Generic pages keep text-only covers. Embedded frames, PDFs, closed shadow-root content, browser pages, and Chrome Web Store pages are outside its scope.
- Tweet text may be as short as one character; other page passages must be at least 20 characters. All passages are limited to 4,000 characters. No image, audio, author-profile, or video interpretation is performed.
- Each scan permits **120 new Jev API evaluations**, with one pending evaluation per page and up to four across the extension. Cached and shared scores do not consume the page budget. Up to 10,000 distinct passages can be queued at once.
- Each document has an in-memory limit of 360 uncached evaluations per hour; worker restarts reset this guardrail. It is not a provider billing cap.
- Jev requests time out after 20 seconds. TrueForge compilation times out after 25 seconds. There are no automatic paid retries.
- Classification is probabilistic. Covers do not remove the underlying DOM text and can be revealed. Unusual website layouts can affect selection and overlay placement.
- Browser validation is left to the user. Automated checks cover the compiler and background messaging with mocked API responses; a separate live SDK smoke test calls the configured model.

## Coverage and limits

- **Open shadow roots are covered.** On every enabled site without a dedicated adaptor, discovery scans the document and every reachable open shadow root, depth-first, so frameworks that compose UI inside open shadow roots are found by the same scan that reads the light DOM.
- **Closed shadow roots are unreachable by design.** The page script never breaks encapsulation: a closed shadow root reports no root to the page script, its content is never classified, and encountering one is silent rather than an error. Content hidden inside a closed root is out of reach even when roots nested inside it are open.
- **Generic coverage is best-effort on proprietary UIs.** Conventional markup — articles, blogs, documentation, forums — is covered reliably; heavily scripted or unusual layouts get the same scan with no site-specific tuning, and coverage quality is only as good as the markup exposes. Dedicated adaptors (X, Reddit, later LinkedIn) close the gap on the sites people actually scroll.
- **Dialog surfaces follow a neutral policy on generic origins.** There is no blanket `role="dialog"` exclusion, so article lightboxes and comment modals are candidate surfaces. Interface chrome stays excluded structurally — navigation, forms, text boxes, and editable areas are never scored — which keeps login modals and cookie banners uncovered.

## TrueForge setup and development

The extension includes the bundled SDK and can be loaded without a build step. To install or update the local compiler agent, use Node.js **22.14 or newer** from this app folder:

```sh
npm ci
npm run setup:trueforge
```

TrueForge must already be running at `http://localhost:8790` with `openai/gpt-5-4-mini` configured. On the machine used for setup, run `~/.local/bin/trueforge` to restart the server. A separate Node 22 runtime is installed under `~/.local/share/trueforge/runtime`; if your terminal still uses Node 20, run:

```sh
export PATH="$HOME/.local/share/trueforge/runtime/node_modules/.bin:$PATH"
```

`setup:trueforge` creates or updates only the dedicated `content-blocker-compiler` agent through the SDK. To use another configured model that supports reasoning effort `none`, set `TRUEFORGE_MODEL` when running the setup script. The extension's **Test TrueForge connection** button verifies the server and agent without calling the model. It does not validate the provider key; saving an instruction does that.

```sh
npm run build       # rebuild extension/vendor/trueforge-sdk.js
npm test            # automated compiler, SDK transport, and background race tests; no paid requests
npm run test:live   # explicitly run a real model compilation and report latency
```

The tests cover strict JSON validation, exceptions in the Jev prompt, refusals, truncated output, paused runs, stream interruption, cancellation, actual SDK request serialization, settings access, existing-rule migration, unchanged-instruction reuse, and stale compilation races. Browser testing remains manual. Jev's existing classification and caching paths are unchanged. Automated DOM checks cover tweet images, late-loaded media, shared reveal, recycled tweets, threshold changes, disabling, and ordinary text passages.

The SDK is pinned to 0.2.0 in the lockfile and bundled locally for Manifest V3; there are no remote scripts or runtime CDN imports. The local server must remain available when saving a changed instruction. Existing filters and Jev evaluation continue working while TrueForge is stopped.

| File | Purpose |
| --- | --- |
| `extension/compiler-agent.js` | Saved agent name, model, strict output schema, prompt, and minimal runtime configuration |
| `extension/rule-compiler.js` | SDK session/stream integration, output validation, and cancellation |
| `extension/vendor/trueforge-sdk.js` | Locally bundled official TrueForge SDK |
| `scripts/setup-trueforge.mjs` | Create or update the dedicated compiler agent using the SDK |
| `extension/jev.js` | Jev classifier using the saved custom question |
| `extension/background.js` | Rules, compilation, API broker, caches, quotas, and site registration |
| `extension/content.js` | Text discovery, page-memory scores, rule invalidation, and overlays |
| `extension/score-cache.js` | Persistent scores, batch lookup, and pending-request sharing |
| `extension/popup.*` | Global instruction editor and current-site controls |
| `extension/options.*` | TrueForge connection check, TypeSafe key, threshold, and enabled sites |
| `extension/request-log.js`, `extension/logs.*` | Jev logging and inspection |
