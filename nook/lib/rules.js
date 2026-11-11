// Simple domain rules that pre-select a likely reason during sorting. No AI in v1.
import { hostOf, hostMatches } from './util.js';
import { SENSITIVE_KEYWORDS } from './constants.js';

const any = (host, list) => list.some((d) => hostMatches(host, d));
// Matches a brand across country domains: amazon.com, amazon.in, amazon.co.uk ...
const brand = (host, name) => new RegExp(`(^|\\.)${name}\\.[a-z.]{2,7}$`).test(host);

const SHOPPING = [
  'etsy.com', 'bestbuy.com', 'walmart.com', 'target.com', 'flipkart.com', 'myntra.com',
  'ikea.com', 'wayfair.com', 'aliexpress.com', 'costco.com', 'homedepot.com', 'lowes.com',
  'newegg.com', 'zara.com', 'hm.com', 'nike.com', 'nykaa.com', 'ajio.com', 'temu.com',
  'shein.com', 'asos.com', 'uniqlo.com', 'sephora.com', 'ulta.com', 'macys.com',
  'nordstrom.com', 'zappos.com', 'bhphotovideo.com', 'rei.com', 'chewy.com', 'kohls.com',
  'meesho.com', 'tatacliq.com', 'croma.com', 'bigbasket.com', 'swiggy.com', 'blinkit.com',
  'store.google.com', 'backmarket.com', 'overstock.com', 'gap.com', 'everlane.com',
];

const READING = [
  'youtube.com', 'youtu.be', 'medium.com', 'substack.com', 'reddit.com', 'x.com', 'twitter.com',
  'news.ycombinator.com', 'vimeo.com', 'ted.com', 'nytimes.com', 'wsj.com', 'washingtonpost.com',
  'theguardian.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'npr.org', 'reuters.com', 'apnews.com',
  'bloomberg.com', 'economist.com', 'ft.com', 'theatlantic.com', 'newyorker.com', 'wired.com',
  'theverge.com', 'arstechnica.com', 'techcrunch.com', 'vox.com', 'axios.com', 'hbr.org',
  'aeon.co', 'nautil.us', 'quantamagazine.org', 'politico.com', 'forbes.com', 'fortune.com',
  'businessinsider.com', 'cnbc.com', 'hindustantimes.com', 'thehindu.com', 'livemint.com',
  'economictimes.indiatimes.com', 'indianexpress.com', 'theprint.in', 'scroll.in', 'linkedin.com',
  'dev.to', 'hashnode.dev', 'stratechery.com', 'lennysnewsletter.com', 'every.to',
];

const TODO = [
  'notion.so', 'notion.site', 'calendly.com', 'forms.gle', 'airtable.com', 'trello.com',
  'asana.com', 'linear.app', 'figma.com', 'canva.com', 'docusign.net', 'typeform.com',
  'jira.atlassian.net', 'clickup.com', 'monday.com', 'coda.io', 'miro.com',
];

const REFERENCE = [
  'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com',
  'superuser.com', 'serverfault.com', 'developer.mozilla.org', 'readthedocs.io', 'devdocs.io',
  'wikipedia.org', 'npmjs.com', 'pypi.org', 'w3schools.com', 'developer.chrome.com',
  'developer.apple.com', 'learn.microsoft.com', 'web.dev', 'caniuse.com', 'mdn.dev',
];

export function suggestIntent(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = hostOf(url);
  const path = u.pathname.toLowerCase();

  // Search result pages: you were looking into something.
  if ((brand(host, 'google') && path === '/search') ||
      (hostMatches(host, 'bing.com') && path === '/search') ||
      (hostMatches(host, 'duckduckgo.com') && u.searchParams.has('q')) ||
      hostMatches(host, 'scholar.google.com') || hostMatches(host, 'perplexity.ai') ||
      (hostMatches(host, 'kagi.com') && path === '/search')) {
    return 'research';
  }

  // Google Docs, Forms, Sheets and Slides are usually work in progress.
  if (hostMatches(host, 'docs.google.com') && /^\/(document|forms|spreadsheets|presentation)\//.test(path)) return 'todo';
  if (hostMatches(host, 'mail.google.com') && /compose|drafts/i.test(u.hash)) return 'todo';
  if (any(host, TODO)) return 'todo';

  // Known sites first, then guesses from the shape of the address.
  if (brand(host, 'amazon') || brand(host, 'ebay') || any(host, SHOPPING)) return 'buying';
  if (any(host, REFERENCE) || host.startsWith('docs.') || host.startsWith('developer.')) return 'reference';
  if (any(host, READING)) return 'read_later';

  if (/\/(dp|gp\/product|products?|item|itm|listing)\/[^/]+/.test(path)) return 'buying';
  if (/\/(docs|documentation|api|reference)(\/|$)/.test(path)) return 'reference';
  if (/\/(blog|article|articles|news|story|posts?)\//.test(path)) return 'read_later';

  return null;
}

export function isSensitive(url, extraDomains = []) {
  const host = hostOf(url);
  if (!host) return false;
  if (SENSITIVE_KEYWORDS.some((k) => host.includes(k))) return true;
  return extraDomains.some((d) => hostMatches(host, d));
}
