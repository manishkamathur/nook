export function uid() {
  return crypto.randomUUID();
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// True if host is the domain itself or a subdomain of it.
export function hostMatches(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith('.' + domain);
}

export function matchesAny(url, domains) {
  const host = hostOf(url);
  return (domains || []).some((d) => hostMatches(host, d));
}

// Turn a pasted list ("https://www.Chase.com/login, zoom.us") into clean domains.
export function parseDomainList(text) {
  return [...new Set(
    String(text || '')
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((s) => s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0])
      .filter((s) => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(s))
  )];
}

// Only real web pages are archived; browser and extension pages are left alone.
export function isArchivableUrl(url) {
  return /^(https?|file):/i.test(url || '');
}

export function sameUrl(a, b) {
  return (a || '').split('#')[0] === (b || '').split('#')[0];
}

export function monthKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function timeAgo(t, now = Date.now()) {
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const w = Math.round(d / 7);
  if (d < 30) return w === 1 ? 'last week' : `${w} weeks ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'your', 'you', 'buy', 'shop', 'online', 'sale', 'free', 'new', 'amazon', 'com', 'in', 'of', 'a', 'to', 'on', 'at', 'by', 'best', 'price', 'prices', 'deals']);

export function titleTokens(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function faviconFor(url, size = 32) {
  const u = new URL(chrome.runtime.getURL('/_favicon/'));
  u.searchParams.set('pageUrl', url);
  u.searchParams.set('size', String(size));
  return u.toString();
}

export function plural(n, one, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

// A promise chain that runs async jobs one at a time.
export function makeLock() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
}
