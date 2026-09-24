// SiteAdaptor registry: pure hostname-to-adaptor resolution. These modules
// carry discovery configuration only — no browser APIs, no classification, no
// persistence — so the mapping stays trivially testable and embeddable.
//
// Adaptor contract: id, matches(hostname), candidates, exclude, targetOf(node),
// minText(node), eligible(node), container. Reserved for later PRs:
// dialogOptIn (content-dialog opt-in) and roots (extra scan roots, e.g. open
// shadow roots); absent hooks fall back to the shipped core behavior.
import {xAdaptor} from './x.js';
import {redditAdaptor} from './reddit.js';
import {linkedinAdaptor} from './linkedin.js';
import {genericAdaptor} from './generic.js';

const SITE_ADAPTORS = [xAdaptor, redditAdaptor, linkedinAdaptor];

export const adaptorFor = hostname => {
  const host = (hostname || '').toLowerCase();
  return SITE_ADAPTORS.find(a => a.matches(host)) ?? genericAdaptor;
};
