// Reddit adaptor: covers the old UI (old.reddit.com and the legacy www
// rendering) and the shreddit UI on the shared detection core. Selectors are
// pinned from structural DOM evidence, not generated class names:
//   - Old UI (archived old.reddit.com front page, 2026-08-31): posts render as
//     div.thing > a.thumbnail > img plus div.entry > div.top-matter > p.title
//     wrapping a.title, flair spans, and span.domain; media expand into
//     div.expando and selftext prose lives under .md.
//   - shreddit (archived www.reddit.com post and detail pages, 2025-01):
//     detail titles are h1[slot="title"] under shreddit-post, comment bodies
//     are div[slot="comment"] inside shreddit-comment, and media sits in
//     [slot="post-media-container"].
// Discovery configuration only: no browser APIs, no classification, no
// persistence. The classic-script core (content.js) carries a runtime mirror
// of this adaptor that tests/registry.test.js keeps honest with it.
export const redditAdaptor = {
  id: 'reddit',
  matches: h => h === 'reddit.com' || h.endsWith('.reddit.com'),
  // Old-UI prose selectors (p, li, blockquote, .md > div, div[dir="auto"])
  // keep the shipped coverage; shreddit boundaries ride stable slots: the
  // post-detail title (h1[slot="title"]) and one candidate per comment body
  // (div[slot="comment"], grouped by the container hook). The shipped
  // tweet-shaped hooks are dropped — dead weight on this origin.
  candidates: 'p, li, blockquote, .md > div, div[dir="auto"], h1[slot="title"], div[slot="comment"]',
  // Shipped exclusion set verbatim: interface elements stay excluded
  // structurally and dialogs stay excluded on this origin.
  exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]',
  // Old-UI link-post titles flag as their title link (a.title), so the cover
  // overlays the title text rather than the flair and domain noise in the
  // p.title paragraph. Media-only posts (no .md selftext) flag as the post's
  // media container — expanded expando media when present, else the
  // thumbnail — so flagging the title hides the media. Everything else keeps
  // a per-passage cover.
  targetOf: node => {
    if (!node.matches('p.title')) return node;
    const post = node.closest('.thing');
    if (!post || post.querySelector('.md')) return node.querySelector('a.title') || node;
    const expanded = post.querySelector('.expando img, .expando video') ? post.querySelector('.expando') : null;
    return expanded || post.querySelector('a.thumbnail') || node.querySelector('a.title') || node;
  },
  // Titles are primary content: topic preferences can match short ones, the
  // way short tweets can. Generic page fragments still need enough text to
  // avoid spending requests on tiny interface labels.
  minText: node => node.matches('p.title, h1[slot="title"]') ? 1 : 20,
  // Media policy: reddit prose routinely carries inline images and embeds
  // (selftext, comment bodies), and the shipped policy dropped any candidate
  // holding media wholesale. Only interactive form controls disqualify a
  // candidate now.
  eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"])'),
  // One candidate per shreddit comment body: inner paragraphs collapse into
  // the slot wrapper instead of spending an evaluation each.
  container: 'div[slot="comment"]',
  // shreddit opt-in: discovery also scans every reachable OPEN shadow root
  // (async-loader hydrated components, embedded surfaces); closed roots are
  // unreachable by design. Mirrors the canonical traversal in roots.js
  // (adaptor modules must not import anything); tests/reddit-coverage.test.js
  // keeps the copy behaviorally equal.
  roots: function collectRoots(root = document) {
    const roots = [root];
    for (const host of root.querySelectorAll('*'))
      if (host.shadowRoot) roots.push(...collectRoots(host.shadowRoot));
    return roots;
  }
};
