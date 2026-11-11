// Fake chrome.* APIs so Nook's real pages render in a normal browser tab for previews.
// Add ?state=empty to the URL to see the first-run screen; the default is a filled sample.
(() => {
  const params = new URLSearchParams(location.search);
  const now = Date.now();
  const H = 3600e3, D = 24 * H;
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  let n = 0;
  const rec = (title, url, intent, ageMs, extra = {}) => {
    const id = 'r' + (++n);
    const domain = new URL(url).hostname;
    return [id, {
      id, url, title, domain, faviconUrl: null, thumbnailKey: null,
      openedAt: now - ageMs - D, lastViewedAt: now - ageMs, archivedAt: now - ageMs,
      intent, savedWindow: null, windowIndex: n, note: '', project: null,
      suggestedIntent: null, status: 'archived', windowId: 1, groupName: null, groupColor: null, source: 'idle',
      ...extra,
    }];
  };

  const sample = {
    records: Object.fromEntries([
      rec('Q4 launch plan', 'https://docs.workpad.app/d/q4-launch', 'todo', 4 * D, { note: 'Finish pricing before Thursday' }),
      rec('Book a 30 minute call with Priya', 'https://meetly.app/priya/30min', 'todo', 2 * D),
      rec('Flights to Goa, Dec 20 to 24', 'https://skyfares.travel/search?to=GOI', 'unsorted', 5 * H),
      rec('Svelte 5 runes, explained', 'https://svelte.dev/blog/runes', 'unsorted', 9 * H),
      rec('Customer interview notes, batch 2', 'https://docs.workpad.app/d/interviews-2', 'unsorted', 20 * H),
      rec('How Postgres picks an index', 'https://blog.pgcraft.dev/index-choice', 'read_later', 6 * D),
      rec('The case for slower software', 'https://longreads.page/slower-software', 'read_later', 7 * D),
      rec('Mesh office chairs, tested for 3 months', 'https://deskreviews.co/mesh-chairs', 'buying', 3 * D),
      rec('Noise-cancelling headphones under ₹15,000', 'https://gadgetbay.in/anc-headphones', 'buying', 5 * D),
      rec('Attention Is All You Need', 'https://arxiv.org/abs/1706.03762', 'research', 14 * D, { project: 'AI in Biz 2 essay' }),
      rec('Tab overload and working memory', 'https://journals.example.edu/tab-overload', 'research', 9 * D, { project: 'AI in Biz 2 essay' }),
      rec('View Transition API', 'https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API', 'reference', 1 * D),
      rec('Sprint board', 'https://board.trackly.io/team/sprint-42', 'window', 1 * D, { savedWindow: 'w1' }),
      rec('Design review notes', 'https://docs.workpad.app/d/design-review', 'window', 1 * D, { savedWindow: 'w1' }),
      rec('Staging dashboard', 'https://staging.nookapp.dev/dashboard', 'window', 1 * D, { savedWindow: 'w1' }),
    ]),
    projects: { 'AI in Biz 2 essay': { name: 'AI in Biz 2 essay', archived: false, createdAt: now - 20 * D } },
    windows: { w1: { id: 'w1', name: 'Sprint 42 work', savedAt: now - D } },
    settings: { welcomeDismissed: true },
    stats: { tidied: { [month]: 184 }, total: 612, restored: 41 },
    license: { plan: 'free' },
    meta: {},
  };
  const empty = { records: {}, projects: {}, windows: {}, settings: {}, stats: { tidied: {}, total: 0, restored: 0 }, license: { plan: 'free' }, meta: {} };

  const store = structuredClone(params.get('state') === 'empty' ? empty : sample);
  if (params.get('theme')) store.settings.theme = params.get('theme');
  const session = {};
  const listeners = new Set();

  function pick(src, keys) {
    if (keys == null) return structuredClone(src);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in src) out[k] = structuredClone(src[k]);
    return out;
  }
  function set(patch) {
    const changes = {};
    for (const [k, v] of Object.entries(patch)) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = structuredClone(v); }
    setTimeout(() => listeners.forEach((fn) => fn(changes, 'local')), 0);
  }
  const records = () => structuredClone(store.records);

  // A small stand-in for the background worker: enough to click around the UI.
  function handle(msg) {
    const r = records();
    const ids = msg.ids || (msg.id ? [msg.id] : []);
    switch (msg.type) {
      case 'saveSettings': set({ settings: { ...store.settings, ...(msg.patch || {}) } }); return { ok: true };
      case 'assign': for (const id of ids) if (r[id]) { r[id].intent = msg.intent; if (msg.project !== undefined) r[id].project = msg.project; } set({ records: r }); return { ok: true };
      case 'restore': case 'deleteRecords': for (const id of ids) delete r[id]; set({ records: r }); return { ok: true, restored: ids.length };
      case 'setNote': if (r[msg.id]) r[msg.id].note = msg.note || msg.text || ''; set({ records: r }); return { ok: true };
      case 'setDone': for (const id of ids) if (r[id]) { r[id].status = msg.done === false ? 'archived' : 'done'; r[id].doneAt = now; } set({ records: r }); return { ok: true };
      case 'putRecords': for (const x of msg.records || []) r[x.id] = x; set({ records: r }); return { ok: true };
      case 'clearAll': set({ records: {}, windows: {} }); return { ok: true };
      default: console.info('[preview] message not simulated:', msg.type, msg); return { ok: true };
    }
  }

  const base = location.origin + '/nook/';
  window.chrome = {
    runtime: {
      getURL: (p = '') => base + String(p).replace(/^\//, ''),
      getManifest: () => ({ manifest_version: 3, name: 'Nook', version: '0.1.0' }),
      sendMessage: (msg) => Promise.resolve(handle(msg)),
      id: 'preview',
    },
    storage: {
      local: {
        get: (keys) => Promise.resolve(pick(store, keys)),
        set: (patch) => { set(patch); return Promise.resolve(); },
      },
      session: {
        get: (keys) => Promise.resolve(pick(session, keys)),
        set: (patch) => { Object.assign(session, patch); return Promise.resolve(); },
        remove: (k) => { delete session[k]; return Promise.resolve(); },
      },
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    },
    tabs: {
      query: () => Promise.resolve([{ id: 7, windowId: 1, url: 'https://example.com/article', title: 'An article', active: true }]),
      create: (o) => { console.info('[preview] would open', o.url); return Promise.resolve({ id: 99 }); },
    },
    windows: { getCurrent: () => Promise.resolve({ id: 1, focused: true }) },
  };
})();
