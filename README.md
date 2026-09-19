# Content Blocker

A Chrome extension that filters page text using one personal instruction. Write **“No travel-related content, but allow local news”** in the popup. OpenAI translates your preference into a classification rule, and Jev evaluates passages against that rule. Matching text receives a white cover that you can click to reveal.

This replaces the previous fixed AI-slop classifier. Nothing is filtered until you save an instruction and enable a site. To block AI-style filler, describe that preference in your instruction.

## Install and set up

1. Unzip the extension download, or clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
3. Select the **`extension` folder** containing `manifest.json`.
4. Open **Content Blocker → Settings**. Enter your **OpenAI API key** and **TypeSafe API key**, then save. Existing TypeSafe keys and site settings are retained when updating the same installation.
5. Open the popup, enter your instruction, and select **Save & apply**. The active-filter summary describes the generated rule.
6. Visit a site and turn on **Filter this site** in the popup. Chrome requests access to that site.

The OpenAI key is used to create a new rule. The TypeSafe key is used for Jev content evaluations. Removing the OpenAI key does not stop an already-saved rule from working. Blank key fields preserve saved keys; use each **Remove saved key** button to delete one.

When updating, replace the files in the folder Chrome already loads, click **Reload** in `chrome://extensions`, and refresh website tabs. Version 2 adds access to `api.openai.com`; approve Chrome's permission update if prompted. Upgrading from Slop Shield does not automatically carry forward AI-slop blocking: save your first custom instruction.

## Controls

| Control | Behavior |
| --- | --- |
| Your filter | One natural-language instruction, up to 2,000 characters, shared across enabled sites. |
| Save & apply | Compile with OpenAI and apply to enabled tabs. The previous rule stays active if compilation fails. Saving the unchanged active instruction reuses it. |
| Clear filter everywhere | Remove the active rule and covers. Site preferences remain saved; no OpenAI request is needed. |
| Filter this site | Enable or disable the current website's origin. |
| Confidence threshold | Cover passages scoring at least this value; default 85/100. |
| White cover | Click, or keyboard-focus and activate, to reveal the text. |
| Reveal all | Remove covers and pause this page until rescan, reload, or a new rule. |
| Rescan page | Reset the page's scan budget and reveal choices, reusing scores for the current rule. |
| Request log | Inspect Jev requests, responses, and individual cache/shared evaluation results. |

## How it works

```mermaid
flowchart TD
    Input[Save your instruction] --> OpenAI[OpenAI creates a structured rule]
    OpenAI --> Saved[Validate and save the rule]
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

Saving a new instruction sends only that instruction and the compiler prompt to the OpenAI Responses API, using `gpt-4.1-mini`, `store: false`, and a strict JSON schema. The returned summary, classifier instructions, block criteria, and allow criteria are validated before replacing your current rule. Refused, malformed, incomplete, failed, or timed-out results leave the previous rule intact.

The compiler is instructed to preserve exceptions and negation: “only show cats” means block content outside that topic, while “no travel except local news” retains the exception. The Jev question includes the original preference and tells the classifier to treat page content as untrusted text, prefer allowing ambiguous passages, and honor exceptions. Model interpretation can still be wrong; inspect the active summary and adjust your instruction as needed.

Implementation references: [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

### Page classification and caching

The page script discovers eligible text throughout the mounted DOM, including off-screen content. Visible and nearby passages are prioritized. It never fetches unloaded tweets or calls a website's private API. Nested tweet text is kept together.

Page memory retains up to 10,000 recent text scores after their DOM nodes disappear. Returning tweets can receive covers without another background message. Persistent cache probes run in batches of 64 independently of slow Jev evaluations, and cache hits still work when the new-evaluation budget is exhausted or an API error has paused new requests.

Jev receives one passage and one question named `should_block`. The question changes with your saved instruction. A positive score means the text should be blocked. The background worker validates the result before saving it; failed evaluations are not cached.

Persistent scores are keyed by a SHA-256 hash of the complete Jev request: text, model, and compiled rule. Different rules cannot reuse each other's decisions. Changing a rule clears page-memory scores and old covers, cancels old network evaluations, and rejects stale requests. Old persistent scores can only be reused when the complete request matches. Threshold changes reuse scores without recompiling a rule.

## Data and permissions

| Information | Where it lives / where it goes |
| --- | --- |
| OpenAI and TypeSafe API keys | Trusted extension local storage, not synced; used only by the background worker. |
| Original instruction and compiled rule | Trusted local extension storage; the instruction goes to OpenAI when compiling, and the compiled rule accompanies Jev evaluations. |
| Eligible page text | Goes to TypeSafe for uncached evaluations on enabled sites, including off-screen text already loaded. Not sent to OpenAI by this extension. |
| Recent text and scores | Page memory, up to 10,000 scores; reset on reload or rule change. |
| Passage fingerprints and scores | Local extension storage, up to 10,000 entries across reloads and browser restarts. |
| Jev request log | Trusted extension session storage, latest 100 events, cleared on browser restart or extension reload. |

API payloads do not include page URLs, cookies, or form-field values. Passage text can still contain private information. Forms, editable areas, navigation, code, and hidden elements are excluded on a best-effort basis. The extension adds no encryption to locally stored keys and has no analytics or automatic log uploads.

Filtering is off on a website until enabled. Disabling a site removes its automatic script registration; its Chrome host permission remains available for re-enabling unless revoked separately in Chrome.

## Request log

The inspector records Jev request bodies (including your rule), response bodies, scores, status codes, timing, errors, and individual cache/shared results. OpenAI compilation, batch cache probes, and page-memory reuse are not logged individually. Logs contain passage text and site origins locally; exports contain those details. Authorization headers are excluded and the active TypeSafe key is redacted from logged data.

Recording can be paused or cleared independently of cached classification scores. Response previews are limited to 16 KB. In-flight requests may finish updating existing events after recording is paused.

## Limits

- Filtering currently covers **text passages**, not entire posts or attached media. Images, video, embedded frames, PDFs, shadow-root content, browser pages, and Chrome Web Store pages are outside its scope.
- Tweet text may be as short as one character; other page passages must be at least 20 characters. All passages are limited to 4,000 characters. No image, audio, author-profile, or video interpretation is performed.
- Each scan permits **120 new Jev API evaluations**, with one pending evaluation per page and up to four across the extension. Cached and shared scores do not consume the page budget. Up to 10,000 distinct passages can be queued at once.
- Each document has an in-memory limit of 360 uncached evaluations per hour; worker restarts reset this guardrail. It is not a provider billing cap.
- Jev requests time out after 20 seconds. OpenAI compilation times out after 25 seconds. There are no automatic paid retries.
- Classification is probabilistic. Covers do not remove the underlying DOM text and can be revealed. Unusual website layouts can affect selection and overlay placement.
- Browser and live-provider validation are left to the user. Automated checks use simulated DOM, Chrome messaging, and API responses only.

## Development

Plain JavaScript, Manifest V3, no runtime dependencies or build step. With Node.js 20 or newer:

```sh
npm test
```

The tests exercise compiler schemas and failures, Jev requests, settings access, rule-change races, cache isolation, off-screen discovery, recycled nodes, popup drafts, key controls, request logging, and redaction. They do not launch a browser or make paid API calls.

| File | Purpose |
| --- | --- |
| `extension/rule-compiler.js` | OpenAI request, structured-output validation, and rule generation |
| `extension/jev.js` | Jev classifier using the saved custom question |
| `extension/background.js` | Keys, rules, compilation, API broker, caches, quotas, and site registration |
| `extension/content.js` | Text discovery, page-memory scores, rule invalidation, and overlays |
| `extension/score-cache.js` | Persistent scores, batch lookup, and pending-request sharing |
| `extension/popup.*` | Global instruction editor and current-site controls |
| `extension/options.*` | Both API keys, threshold, and enabled sites |
| `extension/request-log.js`, `extension/logs.*` | Jev logging and inspection |
