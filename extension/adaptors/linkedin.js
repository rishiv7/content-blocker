// LinkedIn adaptor: the first new-site adaptor on the seam. LinkedIn renders
// user prose in bidi text blocks — span[dir="auto"] for post bodies, comment
// bodies, and search snippets; div[dir="auto"] for block-level fragments —
// so discovery hooks ride direction attributes and ARIA structure, never the
// generated class names LinkedIn rotates aggressively. Surfaces: the feed,
// post detail (modal and /posts/ page), and search results. Selectors are
// pinned from structural fixtures, not a logged-in DOM crawl (LinkedIn gates
// logged-out access hard); the PR documents provenance and the owner's
// local-test path.
export const linkedinAdaptor = {
  id: 'linkedin',
  matches: h => h === 'linkedin.com' || h.endsWith('.linkedin.com'),
  // Post prose, comment bodies, and search snippets are bidi text blocks.
  // The shipped selector only reached the div flavor (spec: "incidental
  // div[dir=auto] matches"); the span flavor is where post text lives.
  candidates: 'span[dir="auto"], div[dir="auto"], p, li, blockquote',
  // No blanket [role="dialog"] rule: the feed's post-detail modal IS a
  // dialog, and post detail is a target surface (spec: per-adaptor dialog
  // opt-in). Interface controls stay excluded structurally — form controls,
  // composers, hidden nodes, and the extension's own covers.
  exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [aria-hidden="true"], [hidden], [data-slop-shield]',
  // A flagged post covers its text container — the bidi block carrying the
  // prose — not the whole card: media beside the flagged text stays visible
  // (unlike X, where the cover spans the whole article). closest() keeps the
  // cover on the text container when a passage is relocated or unwrapped.
  targetOf: node => node.closest('span[dir="auto"], div[dir="auto"]') || node,
  // Post prose and search snippets run long; interface labels stay out of
  // the budget.
  minText: () => 20,
  // Media policy: feed cards routinely carry images beside their text, and
  // hashtag links and "see more" toggles live inside the prose block. Only
  // interactive form controls disqualify a candidate — media and inline
  // links/buttons no longer drop a text block (the shipped policy did).
  eligible: node => !node.querySelector('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
  // The bidi text block is the atomic discovery unit: inner candidates
  // collapse into it, so a post is one candidate, not one per fragment.
  container: 'span[dir="auto"], div[dir="auto"]'
};
