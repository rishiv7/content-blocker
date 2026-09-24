// Generic adaptor: the shipped discovery configuration, served on every origin
// without a site adaptor. The tweet-shaped hooks below are shipped defaults
// mirrored in content.js (kept in sync by tests/registry.test.js). The
// universal-engine upgrades on this adaptor: open-shadow-root discovery and a
// neutral dialog policy.
export const genericAdaptor = {
  id: 'generic',
  matches: () => true,
  candidates: 'p, li, blockquote, [data-testid="tweetText"], [data-ad-preview="message"], .md > div, div[dir="auto"]',
  // Neutral dialog policy: the blanket [role="dialog"] exclusion is dropped —
  // content dialogs (article lightboxes, comment modals) are legitimate
  // candidate surfaces. Interface elements stay excluded structurally (nav,
  // header, form, textbox, contenteditable), so login modals and cookie
  // banners built on those stay uncovered.
  exclude: 'nav, header, footer, aside, form, input, textarea, select, button, pre, code, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [aria-hidden="true"], [hidden], [data-slop-shield]',
  // A flagged tweet covers its whole article, including attached images and
  // quoted content. Other page passages keep their individual text covers.
  targetOf: node => node.matches('[data-testid="tweetText"]') ? node.closest('article') || node : node,
  // Topic preferences can match short tweets; generic page fragments still need
  // enough text to avoid spending requests on tiny interface labels.
  minText: node => node.matches('[data-testid="tweetText"]') ? 1 : 20,
  // Shipped media policy: a candidate holding interactive or media descendants
  // is never scored on its own.
  eligible: node => !node.querySelector('input, textarea, [contenteditable]:not([contenteditable="false"]), img, video, iframe'),
  container: '[data-testid="tweetText"]',
  // Universal-engine opt-in: discovery also scans every reachable OPEN shadow
  // root; closed roots are unreachable by design. This mirrors the canonical
  // traversal in roots.js (adaptor modules must not import anything);
  // tests/generic-engine.test.js keeps the copies behaviorally equal.
  roots: function collectRoots(root = document) {
    const roots = [root];
    for (const host of root.querySelectorAll('*'))
      if (host.shadowRoot) roots.push(...collectRoots(host.shadowRoot));
    return roots;
  }
};
