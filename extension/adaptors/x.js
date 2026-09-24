// X adaptor: discovery configuration for x.com and twitter.com. Builds on the
// shipped seam configuration with two coverage upgrades: dialog opt-in (the
// photo/video modal caption is a first-class candidate) and a media policy
// that no longer skips media-bearing passages.
//
// Selector provenance: the tweet selectors below are the shipped,
// production-verified structural set (data-testid, dir — no generated class
// names). The dialog and media hooks are pinned structurally (role="dialog",
// X's stable data-testids) by tests/x-coverage.test.js: x.com serves HTTP 403
// to this environment's browser, so no live-DOM capture was possible; the
// structural contract, not a DOM snapshot, is what the fixtures lock.
export const xAdaptor = {
  id: 'x',
  matches: h => h === 'x.com' || h === 'twitter.com' || h.endsWith('.x.com') || h.endsWith('.twitter.com'),
  candidates: 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]',
  // Dialog opt-in: the blanket [role="dialog"] exclusion is dropped, so modal
  // captions are discoverable. Interface controls inside dialogs stay
  // excluded structurally — nav landmarks, buttons, textboxes, hidden layers
  // — not by skipping the dialog.
  exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [aria-hidden="true"], [hidden], [data-slop-shield]',
  // Cover grouping. Inside a dialog the cover overlays the flagged caption
  // itself, never the surrounding modal UI. Outside dialogs, flagged tweet
  // text covers its whole article, including attached media and quoted
  // content (shipped grouping, pinned by tests/tweet-cover.test.js). For the
  // media-bearing candidates the media policy admits outside tweet text, a
  // flag earned by text covers the passage itself; a media-only candidate
  // covers its media container so the media is what gets hidden.
  targetOf: node => {
    if (node.closest('[role="dialog"]')) return node;
    if (node.matches('[data-testid="tweetText"]')) return node.closest('article') || node;
    const media = node.querySelector('img, video, iframe');
    if (media && !(node.innerText || '').trim())
      return media.closest('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]') || media;
    return node;
  },
  // Topic preferences can match short tweets; generic page fragments still
  // need enough text to avoid spending requests on tiny interface labels.
  minText: node => node.matches('[data-testid="tweetText"]') ? 1 : 20,
  // Media policy: media descendants no longer disqualify a passage — a
  // media-bearing tweet is scored on its text instead of being skipped.
  // Interactive controls still disqualify.
  eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"])'),
  container: '[data-testid="tweetText"]'
};
