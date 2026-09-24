// Canonical open-shadow-root traversal: the given root (the document by
// default) plus every reachable OPEN shadow root inside it, depth-first.
// Closed shadow roots report shadowRoot === null and are skipped silently —
// they are structurally unreachable, not an error. Discovery configuration
// only: no browser-extension APIs, no classification, no persistence. Site
// adaptors may import this in their own PRs; the classic-script core
// (content.js) and the generic adaptor carry behaviorally identical inline
// copies that tests/generic-engine.test.js audits.
export const collectRoots = (root = document) => {
  const roots = [root];
  for (const host of root.querySelectorAll('*'))
    if (host.shadowRoot) roots.push(...collectRoots(host.shadowRoot));
  return roots;
};
