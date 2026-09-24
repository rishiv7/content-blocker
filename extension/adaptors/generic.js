// Generic adaptor: the shipped discovery configuration, served on every origin
// without a site adaptor. The tweet-shaped hooks below are shipped defaults
// mirrored in content.js (kept in sync by tests/registry.test.js); the
// universal-engine PR replaces them with purely document-oriented discovery.
export const genericAdaptor = {
  id: 'generic',
  matches: () => true,
  candidates: 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]',
  exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [aria-hidden="true"], [hidden], [data-slop-shield]',
  // A flagged tweet covers its whole article, including attached images and
  // quoted content. Other page passages keep their individual text covers.
  targetOf: node => node.matches('[data-testid="tweetText"]') ? node.closest('article') || node : node,
  // Topic preferences can match short tweets; generic page fragments still need
  // enough text to avoid spending requests on tiny interface labels.
  minText: node => node.matches('[data-testid="tweetText"]') ? 1 : 20,
  // Shipped media policy: a candidate holding interactive or media descendants
  // is never scored on its own.
  eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe'),
  container: '[data-testid="tweetText"]'
};
