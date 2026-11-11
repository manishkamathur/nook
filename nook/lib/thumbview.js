// Thumbnail with a calm fallback (favicon + site name) while it loads or when there's none.
import { getThumb } from './thumbs.js';
import { h } from './ui.js';
import { faviconFor } from './util.js';

const cache = new Map();

export function thumbUrl(key) {
  if (!key) return Promise.resolve(null);
  if (!cache.has(key)) {
    cache.set(key, getThumb(key).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
  }
  return cache.get(key);
}

export function thumbView(record, { className = 'thumb', faviconSize = 32 } = {}) {
  const el = h('div', { class: className },
    h('div', { class: 'thumb-fallback' },
      h('span', { class: 'thumb-fav' }, h('img', { src: faviconFor(record.url, faviconSize), width: faviconSize, height: faviconSize, alt: '' })),
      h('span', { class: 'thumb-site' }, record.domain || ''),
    ),
  );
  thumbUrl(record.thumbnailKey).then((url) => {
    if (!url) return;
    const img = h('img', { class: 'thumb-shot', alt: '', src: url });
    img.addEventListener('load', () => img.classList.add('loaded'));
    el.append(img);
  });
  return el;
}
