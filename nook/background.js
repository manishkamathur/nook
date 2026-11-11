// Nook background worker: quiet archiving, thumbnails, restore, sorting, follow-through.
import {
  INTENTS, FREE_LIMIT, DEFAULT_SETTINGS, PAYMENTS, NOTE_MAX,
  FADE_AFTER_DAYS, CLEAR_FADING_AFTER_DAYS,
} from './lib/constants.js';
import {
  uid, hostOf, matchesAny, isArchivableUrl, sameUrl, monthKey, makeLock, plural,
} from './lib/util.js';
import { suggestIntent, isSensitive } from './lib/rules.js';
import { putThumb, deleteThumbs, clearThumbs, collectGarbage } from './lib/thumbs.js';
import { getAll, getRecords, getSettings, isLifetime, isDevBuild } from './lib/store.js';

const local = chrome.storage.local;
const session = chrome.storage.session;

const ALARM_TICK = 'nook-tick';
const ALARM_DIGEST = 'nook-digest';
const TICK_MINUTES = 15;
const ASLEEP_GAP_MS = 40 * 60 * 1000;   // a longer gap between ticks means the browser was closed or asleep
const DAILY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const lock = makeLock();         // all record writes
const sessionLock = makeLock();  // live thumbnail and tab bookkeeping
const captureLock = makeLock();  // Chrome allows about 2 screenshots per second

const nookUrl = (hash = '') => chrome.runtime.getURL('pages/nook.html') + (hash ? '#' + hash : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settingsCache = null;
async function settings() {
  if (!settingsCache) settingsCache = await getSettings();
  return settingsCache;
}

async function license() {
  const { license: l } = await local.get('license');
  return l || { plan: 'free' };
}
async function pro() {
  return isLifetime(await license());
}

// ---------------------------------------------------------------------------
// Setup

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings: s } = await local.get('settings');
  if (!s) await local.set({ settings: { ...DEFAULT_SETTINGS, fadeOptIn: true } });
  else if (!s.fadeOptIn) {
    // Earlier builds turned fading on by default. It's opt-in now, so switch it off once.
    await local.set({ settings: { ...s, expiryEnabled: false, fadeOptIn: true } });
  }
  await resetBaseline();
  await setupMenus();
  await ensureAlarms();
  await scheduleDigest();
  await updateBadge();
  if (reason === 'install') chrome.tabs.create({ url: nookUrl('welcome') });
});

chrome.runtime.onStartup.addListener(async () => {
  await resetBaseline();
  await ensureAlarms();
  await scheduleDigest();
  await updateBadge();
});

// Idle time only counts while the browser is actually in use. After a restart or
// sleep, every tab gets a fresh start instead of being swept away at once.
async function resetBaseline() {
  const { meta = {} } = await local.get('meta');
  const now = Date.now();
  await local.set({ meta: { ...meta, baseline: now, lastTick: now } });
}

async function ensureAlarms() {
  const tick = await chrome.alarms.get(ALARM_TICK);
  if (!tick) chrome.alarms.create(ALARM_TICK, { delayInMinutes: 1, periodInMinutes: TICK_MINUTES });
}

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  const contexts = ['page', 'action'];
  chrome.contextMenus.create({ id: 'nook-tab', title: 'Rest this tab in Nook', contexts });
  chrome.contextMenus.create({ id: 'nook-others', title: 'Rest all other tabs', contexts });
  chrome.contextMenus.create({ id: 'nook-window', title: 'Rest this window', contexts });
  chrome.contextMenus.create({ id: 'nook-open', title: 'Open Nook', contexts: ['action'] });
}

ensureAlarms();

// ---------------------------------------------------------------------------
// Tab bookkeeping

chrome.tabs.onCreated.addListener(async (tab) => {
  await sessionLock(async () => {
    const { seen = {} } = await session.get('seen');
    seen[tab.id] = { openedAt: Date.now() };
    await session.set({ seen });
  });
  const s = await settings();
  const url = tab.pendingUrl || tab.url;
  if (s.newTabOverride && (url === 'chrome://newtab/' || url === 'edge://newtab/')) {
    chrome.tabs.update(tab.id, { url: nookUrl() }).catch(() => {});
  }
  if (s.maxTabsEnabled) scheduleCapCheck();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await sessionLock(async () => {
    const { seen = {} } = await session.get('seen');
    seen[tabId] = { ...(seen[tabId] || {}), viewedAt: Date.now() };
    await session.set({ seen });
  });
  scheduleCapture(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) scheduleCapture(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) scheduleCapture(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearCaptureTimers(tabId);
  sessionLock(async () => {
    const { live = {}, seen = {} } = await session.get(['live', 'seen']);
    const gone = live[tabId];
    delete live[tabId];
    delete seen[tabId];
    await session.set({ live, seen });
    if (gone) await deleteThumbs([gone.key]);
  });
});

chrome.tabs.onReplaced.addListener((addedId, removedId) => {
  sessionLock(async () => {
    const { live = {}, seen = {} } = await session.get(['live', 'seen']);
    if (live[removedId]) { live[addedId] = live[removedId]; delete live[removedId]; }
    if (seen[removedId]) { seen[addedId] = seen[removedId]; delete seen[removedId]; }
    await session.set({ live, seen });
  });
});

// ---------------------------------------------------------------------------
// Thumbnails. An extension can only screenshot the tab that's showing, so Nook
// takes one after a tab has been visible for a couple of seconds, and again a
// little later for pages that keep loading.

const captureTimers = new Map();

function clearCaptureTimers(tabId) {
  const t = captureTimers.get(tabId);
  if (t) t.forEach(clearTimeout);
  captureTimers.delete(tabId);
}

function scheduleCapture(tabId) {
  clearCaptureTimers(tabId);
  captureTimers.set(tabId, [
    setTimeout(() => captureIfVisible(tabId), 2000),
    setTimeout(() => { captureTimers.delete(tabId); captureIfVisible(tabId); }, 15000),
  ]);
}

async function captureIfVisible(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || tab.status !== 'complete' || tab.incognito || !/^https?:/.test(tab.url || '')) return;
  const s = await settings();
  if (isSensitive(tab.url, s.noScreenshotDomains)) {
    await dropLiveThumb(tabId);
    return;
  }
  await captureTab(tab);
}

async function dropLiveThumb(tabId) {
  await sessionLock(async () => {
    const { live = {} } = await session.get('live');
    const gone = live[tabId];
    if (!gone) return;
    delete live[tabId];
    await session.set({ live });
    await deleteThumbs([gone.key]);
  });
}

let lastCaptureAt = 0;
function captureTab(tab) {
  return captureLock(async () => {
    const wait = 600 - (Date.now() - lastCaptureAt);
    if (wait > 0) await sleep(wait);
    const cur = await chrome.tabs.get(tab.id).catch(() => null);
    if (!cur || !cur.active || !sameUrl(cur.url, tab.url)) return;
    const win = await chrome.windows.get(cur.windowId).catch(() => null);
    if (!win || win.state === 'minimized') return;
    lastCaptureAt = Date.now();
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(cur.windowId, { format: 'jpeg', quality: 85 });
    } catch {
      return; // e.g. the Web Store or another page Chrome won't let extensions capture
    }
    const blob = await shrink(dataUrl).catch(() => null);
    if (!blob) return;
    await sessionLock(async () => {
      const { live = {} } = await session.get('live');
      const prev = live[cur.id];
      const key = prev && sameUrl(prev.url, cur.url) ? prev.key : uid();
      if (prev && prev.key !== key) await deleteThumbs([prev.key]);
      await putThumb(key, blob, cur.url);
      live[cur.id] = { key, url: cur.url, at: Date.now() };
      await session.set({ live });
    });
  });
}

async function shrink(dataUrl) {
  const src = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(src);
  const width = 560;
  const height = Math.round((bmp.height * width) / bmp.width);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.64 });
}

// ---------------------------------------------------------------------------
// Archiving

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_TICK) await tick();
  if (alarm.name === ALARM_DIGEST) await sendDigest();
});

async function tick({ ignoreBaseline = false } = {}) {
  const now = Date.now();
  const { meta = {} } = await local.get('meta');
  if (!meta.lastTick || now - meta.lastTick > ASLEEP_GAP_MS) meta.baseline = now;
  meta.lastTick = now;
  await local.set({ meta });
  const result = await autoArchive(ignoreBaseline ? 0 : meta.baseline || 0);
  if (!meta.lastDaily || now - meta.lastDaily > DAILY_MS) {
    await daily();
    const { meta: m2 = {} } = await local.get('meta');
    await local.set({ meta: { ...m2, lastDaily: now } });
  }
  return result;
}

function autoEligible(tab, s) {
  return !tab.active && !tab.pinned && !tab.audible && !tab.incognito &&
    isArchivableUrl(tab.url) && !matchesAny(tab.url, s.neverCloseDomains);
}

async function autoArchive(baseline) {
  const s = await settings();
  const tabs = await chrome.tabs.query({});
  const { seen = {} } = await session.get('seen');
  const now = Date.now();
  const viewed = (t) => Math.max(t.lastAccessed || seen[t.id]?.viewedAt || 0, baseline);

  const eligible = tabs.filter((t) => autoEligible(t, s));
  const idleMs = s.idleMinutes * 60 * 1000;
  const chosen = new Set(eligible.filter((t) => now - viewed(t) >= idleMs).map((t) => t.id));

  if (s.maxTabsEnabled) {
    const open = tabs.filter((t) => !t.incognito).length - chosen.size;
    let extra = open - s.maxTabs;
    const oldestFirst = eligible.filter((t) => !chosen.has(t.id)).sort((a, b) => viewed(a) - viewed(b));
    for (const t of oldestFirst) {
      if (extra <= 0) break;
      chosen.add(t.id);
      extra--;
    }
  }
  if (!chosen.size) return { archived: 0, blocked: 0 };
  return archiveTabs(tabs.filter((t) => chosen.has(t.id)), 'auto');
}

let capTimer = null;
function scheduleCapCheck() {
  clearTimeout(capTimer);
  capTimer = setTimeout(async () => {
    const s = await settings();
    if (!s.maxTabsEnabled) return;
    const { meta = {} } = await local.get('meta');
    // Only the cap applies here; the idle sweep runs on its own schedule.
    const tabs = await chrome.tabs.query({});
    const open = tabs.filter((t) => !t.incognito).length;
    if (open <= s.maxTabs) return;
    const { seen = {} } = await session.get('seen');
    const viewed = (t) => Math.max(t.lastAccessed || seen[t.id]?.viewedAt || 0, meta.baseline || 0);
    const oldest = tabs.filter((t) => autoEligible(t, s)).sort((a, b) => viewed(a) - viewed(b)).slice(0, open - s.maxTabs);
    if (oldest.length) await archiveTabs(oldest, 'auto');
  }, 3000);
}

async function archiveTabs(tabs, source, { asWindow = false, name = '' } = {}) {
  // Make sure a tab that's on screen right now gets a thumbnail before it closes.
  const s = await settings();
  const { live: liveNow = {} } = await session.get('live');
  for (const t of tabs) {
    if (t.active && /^https?:/.test(t.url || '') && !isSensitive(t.url, s.noScreenshotDomains) &&
        !(liveNow[t.id] && sameUrl(liveNow[t.id].url, t.url))) {
      await captureTab(t);
    }
  }

  return lock(async () => {
    const { records = {}, stats = {}, windows = {} } = await local.get(['records', 'stats', 'windows']);
    const lifetime = await pro();
    const now = Date.now();
    // A saved window is a snapshot: its tabs are kept as they were, never merged with other items.
    const byUrl = new Map(Object.values(records).filter((r) => !r.savedWindow).map((r) => [r.url.split('#')[0], r]));
    const savedWindow = asWindow ? { id: uid(), name: String(name || '').trim().slice(0, 60) || windowName(now), savedAt: now } : null;
    let count = Object.keys(records).length;
    const closing = [];
    let blocked = 0;

    const taken = await sessionLock(async () => {
      const { live = {}, seen = {} } = await session.get(['live', 'seen']);
      const out = {};
      for (const t of tabs) {
        if (live[t.id] && sameUrl(live[t.id].url, t.url)) out[t.id] = live[t.id].key;
        out['seen' + t.id] = seen[t.id];
      }
      return out;
    });

    for (const tab of tabs) {
      if (!isArchivableUrl(tab.url)) continue;
      let groupName = null;
      let groupColor = null;
      if (tab.groupId > -1) {
        try {
          const g = await chrome.tabGroups.get(tab.groupId);
          groupName = g.title || null;
          groupColor = g.color;
        } catch { /* group already gone */ }
      }
      const thumbKey = taken[tab.id] || null;
      const seen = taken['seen' + tab.id] || {};
      const existing = asWindow ? null : byUrl.get(tab.url.split('#')[0]);

      if (existing) {
        // Already in Nook: refresh it rather than keeping a duplicate.
        existing.title = tab.title || existing.title;
        existing.archivedAt = now;
        existing.lastViewedAt = tab.lastAccessed || seen.viewedAt || existing.lastViewedAt;
        if (thumbKey) existing.thumbnailKey = thumbKey;
        if (existing.status === 'fading' || existing.status === 'done') {
          existing.status = 'archived';
          existing.fadingAt = null;
        }
      } else {
        if (!lifetime && count >= FREE_LIMIT) { blocked++; continue; }
        const r = {
          id: uid(),
          url: tab.url,
          title: tab.title || hostOf(tab.url) || tab.url,
          domain: hostOf(tab.url),
          faviconUrl: tab.favIconUrl && !tab.favIconUrl.startsWith('data:') ? tab.favIconUrl : null,
          thumbnailKey: thumbKey,
          openedAt: seen.openedAt || null,
          lastViewedAt: tab.lastAccessed || seen.viewedAt || null,
          archivedAt: now,
          intent: asWindow ? 'window' : 'unsorted',
          savedWindow: savedWindow ? savedWindow.id : null,
          windowIndex: tab.index,
          note: '',
          project: null,
          suggestedIntent: suggestIntent(tab.url),
          status: 'archived',
          windowId: tab.windowId,
          groupName,
          groupColor,
          source,
        };
        records[r.id] = r;
        if (!asWindow) byUrl.set(r.url.split('#')[0], r);
        count++;
      }
      closing.push(tab);
    }

    if (closing.length) {
      const mk = monthKey(now);
      const tidied = { ...(stats.tidied || {}) };
      tidied[mk] = (tidied[mk] || 0) + closing.length;
      await local.set({
        records,
        stats: { ...stats, tidied, total: (stats.total || 0) + closing.length },
        ...(savedWindow ? { windows: { ...windows, [savedWindow.id]: savedWindow } } : {}),
      });
      // These thumbnails now belong to saved items, not to open tabs.
      await sessionLock(async () => {
        const { live = {} } = await session.get('live');
        closing.forEach((t) => delete live[t.id]);
        await session.set({ live });
      });
      await closeTabsSafely(closing);
    }
    if (blocked) {
      const { meta = {} } = await local.get('meta');
      await local.set({ meta: { ...meta, fullAt: now } });
    }
    return { archived: closing.length, blocked };
  });
}

// Never let archiving close the last window (that would quit the browser).
async function closeTabsSafely(tabs) {
  const ids = new Set(tabs.map((t) => t.id));
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const survives = windows.some((w) => w.tabs.some((t) => !ids.has(t.id)));
  if (!survives) {
    const target = windows.find((w) => w.focused) || windows[0];
    if (target) await chrome.tabs.create({ windowId: target.id, url: nookUrl() });
  }
  await Promise.allSettled([...ids].map((id) => chrome.tabs.remove(id)));
}

function windowName(t) {
  const when = new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Window from ${when}`;
}

async function manualArchive({ scope, tabId, windowId, name = '' }) {
  let tabs = [];
  if (scope === 'tab') {
    const t = tabId ? await chrome.tabs.get(tabId).catch(() => null)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (t) tabs = [t];
  } else {
    const win = windowId ?? (await chrome.windows.getLastFocused()).id;
    const all = await chrome.tabs.query({ windowId: win });
    tabs = all.filter((t) => !t.pinned && (scope === 'window' || !t.active));
  }
  tabs = tabs.filter((t) => isArchivableUrl(t.url) && !t.url.startsWith(chrome.runtime.getURL('')));
  if (!tabs.length) return { archived: 0, blocked: 0 };
  return archiveTabs(tabs, 'manual', { asWindow: scope === 'window', name });
}

// ---------------------------------------------------------------------------
// Restoring

async function restore({ ids, remove = false, windowId, asGroup = false, title, color, background = false }) {
  return lock(async () => {
    const records = await getRecords();
    const list = ids.map((id) => records[id]).filter(Boolean);
    if (!list.length) return { opened: 0 };

    let win = windowId;
    if (win != null) {
      const ok = await chrome.windows.get(win).catch(() => null);
      if (!ok) win = null;
    }
    if (win == null) {
      const w = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
      win = w ? w.id : (await chrome.windows.create({ focused: true })).id;
    }

    const created = [];
    for (let i = 0; i < list.length; i++) {
      const t = await chrome.tabs.create({ windowId: win, url: list[i].url, active: !background && i === 0 });
      created.push(t.id);
    }

    try {
      if (asGroup) {
        const groupId = await chrome.tabs.group({ tabIds: created, createProperties: { windowId: win } });
        await chrome.tabGroups.update(groupId, { title: title || 'Nook', color: color || 'grey', collapsed: false });
      } else if (list.length === 1 && list[0].groupName) {
        // Put it back in the group it came from, if that group is still around.
        const [g] = await chrome.tabGroups.query({ windowId: win, title: list[0].groupName });
        if (g) await chrome.tabs.group({ groupId: g.id, tabIds: created });
      }
    } catch { /* grouping is a nicety; the tabs are open either way */ }

    const now = Date.now();
    for (const r of list) {
      if (remove) {
        delete records[r.id];
      } else {
        r.restoredAt = now;
        r.restoreCount = (r.restoreCount || 0) + 1;
        if (r.status === 'fading') {
          r.status = 'archived';
          r.fadingAt = null;
          r.sortedAt = now;
        }
      }
    }
    const { stats = {} } = await local.get('stats');
    await local.set({ records, stats: { ...stats, restored: (stats.restored || 0) + list.length } });
    if (!background) chrome.windows.update(win, { focused: true }).catch(() => {});
    return { opened: created.length };
  });
}

// ---------------------------------------------------------------------------
// Sorting and editing

const VALID_INTENTS = new Set(Object.keys(INTENTS));

async function assign({ ids, intent, project = null }) {
  if (intent === 'window' || (intent !== 'close' && !VALID_INTENTS.has(intent))) throw new Error('Unknown reason.');
  return lock(async () => {
    const { records = {}, projects = {} } = await local.get(['records', 'projects']);
    const lifetime = await pro();
    let name = intent === 'research' && project ? String(project).trim().slice(0, 60) : null;
    if (name && !projects[name]) {
      if (!lifetime) name = null;
      else projects[name] = { name, archived: false, createdAt: Date.now() };
    }
    const now = Date.now();
    for (const id of ids) {
      const r = records[id];
      if (!r) continue;
      if (intent === 'close') { delete records[id]; continue; }
      r.intent = intent;
      r.project = intent === 'research' ? name : null;
      r.savedWindow = null; // moving a tab out of a saved window
      r.sortedAt = now;
      r.status = 'archived';
      r.fadingAt = null;
      r.doneAt = null;
    }
    await local.set({ records, projects });
    return { ok: true };
  });
}

async function setDone({ id, done }) {
  return lock(async () => {
    const records = await getRecords();
    const r = records[id];
    if (!r) return { ok: false };
    r.status = done ? 'done' : 'archived';
    r.doneAt = done ? Date.now() : null;
    await local.set({ records });
    return { ok: true };
  });
}

async function keep({ ids }) {
  return lock(async () => {
    const records = await getRecords();
    const now = Date.now();
    ids.forEach((id) => {
      const r = records[id];
      if (r) { r.status = 'archived'; r.fadingAt = null; r.sortedAt = now; }
    });
    await local.set({ records });
    return { ok: true };
  });
}

async function deleteRecords({ ids }) {
  return lock(async () => {
    const records = await getRecords();
    ids.forEach((id) => delete records[id]);
    await local.set({ records });
    return { ok: true };
  });
}

// Puts back records exactly as they were (used by undo).
async function putRecords({ records: incoming }) {
  return lock(async () => {
    const records = await getRecords();
    for (const r of incoming || []) if (r && r.id && r.url) records[r.id] = r;
    await local.set({ records });
    return { ok: true };
  });
}

async function importItems({ items = [], projects: incomingProjects = [], windows: incomingWindows = [] }) {
  return lock(async () => {
    const { records = {}, projects = {}, windows = {} } = await local.get(['records', 'projects', 'windows']);
    // Saved windows get fresh ids; their tabs are snapshots, so they skip the duplicate check.
    const windowIds = {};
    for (const w of incomingWindows) {
      if (!w || !w.id) continue;
      const id = uid();
      windowIds[w.id] = id;
      windows[id] = { id, name: String(w.name || 'Saved window').slice(0, 60), savedAt: Number(w.savedAt) || Date.now() };
    }
    const lifetime = await pro();
    const urls = new Set(Object.values(records).map((r) => r.url.split('#')[0]));
    let count = Object.keys(records).length;
    let added = 0;
    let skipped = 0;
    const now = Date.now();
    if (lifetime) {
      for (const p of incomingProjects) {
        if (p && p.name && !projects[p.name]) projects[p.name] = { name: p.name, archived: !!p.archived, createdAt: p.createdAt || now };
      }
    }
    for (const it of items) {
      const url = String(it.url || '');
      const savedWindow = windowIds[it.savedWindow] || null;
      if (!/^(https?|file):/i.test(url) || (!savedWindow && urls.has(url.split('#')[0]))) { skipped++; continue; }
      if (!lifetime && count >= FREE_LIMIT) { skipped++; continue; }
      let intent = VALID_INTENTS.has(it.intent) ? it.intent : 'unsorted';
      if (intent === 'window' && !savedWindow) intent = 'unsorted';
      const project = intent === 'research' && lifetime && it.project ? String(it.project) : null;
      if (project && !projects[project]) projects[project] = { name: project, archived: false, createdAt: now };
      const r = {
        id: uid(),
        url,
        title: String(it.title || hostOf(url) || url).slice(0, 500),
        domain: hostOf(url),
        faviconUrl: null,
        thumbnailKey: null,
        openedAt: Number(it.openedAt) || null,
        lastViewedAt: Number(it.lastViewedAt) || null,
        archivedAt: Number(it.archivedAt) || now,
        intent,
        project,
        suggestedIntent: suggestIntent(url),
        status: ['archived', 'done', 'fading'].includes(it.status) ? it.status : 'archived',
        sortedAt: intent === 'unsorted' ? null : now,
        note: String(it.note || '').slice(0, NOTE_MAX),
        savedWindow: intent === 'window' ? savedWindow : null,
        windowIndex: Number.isFinite(it.windowIndex) ? it.windowIndex : null,
        groupName: it.groupName ? String(it.groupName).slice(0, 60) : null,
        groupColor: it.groupColor || null,
        doneAt: Number(it.doneAt) || null,
        fadingAt: Number(it.fadingAt) || null,
        source: 'import',
      };
      records[r.id] = r;
      if (!r.savedWindow) urls.add(url.split('#')[0]);
      count++;
      added++;
    }
    // Drop imported windows that ended up with no tabs (all skipped).
    for (const id of Object.values(windowIds)) {
      if (!Object.values(records).some((r) => r.savedWindow === id)) delete windows[id];
    }
    await local.set({ records, projects, windows });
    return { added, skipped };
  });
}

async function projectAction({ action, name, archived, newName }) {
  return lock(async () => {
    const { records = {}, projects = {} } = await local.get(['records', 'projects']);
    if (action === 'create') {
      if (!(await pro())) throw new Error('Research projects come with Nook Lifetime.');
      const n = String(name || '').trim().slice(0, 60);
      if (!n) throw new Error('Give the project a name.');
      if (!projects[n]) projects[n] = { name: n, archived: false, createdAt: Date.now() };
    } else if (action === 'archive' && projects[name]) {
      projects[name].archived = !!archived;
    } else if (action === 'rename' && projects[name]) {
      const n = String(newName || '').trim().slice(0, 60);
      if (!n || projects[n]) throw new Error('Pick a name that isn’t taken.');
      projects[n] = { ...projects[name], name: n };
      delete projects[name];
      Object.values(records).forEach((r) => { if (r.project === name) r.project = n; });
    } else if (action === 'delete') {
      Object.values(records).forEach((r) => { if (r.intent === 'research' && r.project === name) delete records[r.id]; });
      delete projects[name];
    }
    await local.set({ records, projects });
    return { ok: true };
  });
}

// Reopen every tab from a saved window, in order, in a new window, with its tab groups.
async function restoreWindow({ id, remove = false }) {
  return lock(async () => {
    const { records = {}, windows = {}, stats = {} } = await local.get(['records', 'windows', 'stats']);
    const list = Object.values(records)
      .filter((r) => r.savedWindow === id)
      .sort((a, b) => (a.windowIndex ?? 0) - (b.windowIndex ?? 0));
    if (!list.length) return { opened: 0 };
    const win = await chrome.windows.create({ url: list.map((r) => r.url), focused: true });
    const tabs = win.tabs || (await chrome.tabs.query({ windowId: win.id }));
    const groups = new Map();
    list.forEach((r, i) => {
      if (!r.groupName || !tabs[i]) return;
      if (!groups.has(r.groupName)) groups.set(r.groupName, { color: r.groupColor, ids: [] });
      groups.get(r.groupName).ids.push(tabs[i].id);
    });
    for (const [title, g] of groups) {
      try {
        const gid = await chrome.tabs.group({ tabIds: g.ids, createProperties: { windowId: win.id } });
        await chrome.tabGroups.update(gid, { title, color: g.color || 'grey' });
      } catch { /* grouping is a nicety */ }
    }
    const now = Date.now();
    if (remove) {
      list.forEach((r) => delete records[r.id]);
      delete windows[id];
    } else {
      list.forEach((r) => { r.restoredAt = now; r.restoreCount = (r.restoreCount || 0) + 1; });
      if (windows[id]) windows[id].restoredAt = now;
    }
    await local.set({ records, windows, stats: { ...stats, restored: (stats.restored || 0) + list.length } });
    return { opened: list.length };
  });
}

async function windowAction({ action, id, name, entry }) {
  return lock(async () => {
    const { records = {}, windows = {} } = await local.get(['records', 'windows']);
    if (action === 'rename' && windows[id]) {
      const n = String(name || '').trim().slice(0, 60);
      if (!n) throw new Error('Give the window a name.');
      windows[id].name = n;
    } else if (action === 'delete') {
      Object.values(records).forEach((r) => { if (r.savedWindow === id) delete records[r.id]; });
      delete windows[id];
    } else if (action === 'put' && entry && entry.id) {
      windows[entry.id] = entry; // used by undo
    }
    await local.set({ records, windows });
    return { ok: true };
  });
}

async function setNote({ id, note }) {
  return lock(async () => {
    const records = await getRecords();
    const r = records[id];
    if (!r) throw new Error('That tab is no longer in Nook.');
    r.note = String(note || '').replace(/\s+\n/g, '\n').trim().slice(0, NOTE_MAX);
    await local.set({ records });
    return { ok: true };
  });
}

async function clearAll() {
  return lock(async () => {
    await local.set({ records: {}, projects: {}, windows: {}, stats: { tidied: {}, total: 0, restored: 0 } });
    await sessionLock(async () => { await session.set({ live: {} }); });
    await clearThumbs();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Follow-through: weekly Read later digest, fading, cleanup

function nextDigestTime(day, hour, from = Date.now()) {
  const d = new Date(from);
  d.setHours(hour, 0, 0, 0);
  let add = (day - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= from) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

async function scheduleDigest() {
  const s = await settings();
  await chrome.alarms.clear(ALARM_DIGEST);
  if (!(await pro()) || !s.digestEnabled) return;
  chrome.alarms.create(ALARM_DIGEST, { when: nextDigestTime(s.digestDay, s.digestHour) });
}

async function sendDigest() {
  const s = await settings();
  if ((await pro()) && s.digestEnabled) {
    const records = Object.values(await getRecords());
    const waiting = records.filter((r) => r.intent === 'read_later' && r.status === 'archived');
    const weekAgo = Date.now() - 7 * DAY_MS;
    const thisWeek = waiting.filter((r) => (r.sortedAt || r.archivedAt) >= weekAgo).length;
    if (waiting.length) {
      chrome.notifications.create('nook-digest', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Your reading pile',
        message: thisWeek
          ? `${plural(thisWeek, 'thing')} you saved to read this week.`
          : `${plural(waiting.length, 'thing')} waiting in Read later.`,
        priority: 0,
      });
    }
  }
  await scheduleDigest();
}

async function daily() {
  const s = await settings();
  if ((await pro()) && s.expiryEnabled) {
    const newlyFading = await lock(async () => {
      const records = await getRecords();
      const now = Date.now();
      let fading = 0;
      for (const r of Object.values(records)) {
        if (r.intent !== 'read_later') continue;
        const since = Math.max(r.sortedAt || 0, r.restoredAt || 0, r.archivedAt || 0);
        if (r.status === 'archived' && now - since > FADE_AFTER_DAYS * DAY_MS) {
          r.status = 'fading';
          r.fadingAt = now;
          fading++;
        } else if (r.status === 'fading' && now - (r.fadingAt || now) > CLEAR_FADING_AFTER_DAYS * DAY_MS) {
          delete records[r.id];
        }
      }
      await local.set({ records });
      return fading;
    });
    if (newlyFading) {
      chrome.notifications.create('nook-fading', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Some reading is fading',
        message: `${plural(newlyFading, 'Read later tab')} haven't been opened in ${FADE_AFTER_DAYS} days. Nook will clear them in ${CLEAR_FADING_AFTER_DAYS} days unless you keep them.`,
        priority: 0,
      });
    }
  }
  const records = Object.values(await getRecords());
  const { live = {} } = await session.get('live');
  const keepKeys = new Set([
    ...records.map((r) => r.thumbnailKey).filter(Boolean),
    ...Object.values(live).map((l) => l.key),
  ]);
  await collectGarbage(keepKeys).catch(() => {});
}

chrome.notifications.onClicked.addListener((id) => {
  if (id === 'nook-digest') openNook('read_later');
  if (id === 'nook-fading') openNook('fading');
  chrome.notifications.clear(id);
});

// ---------------------------------------------------------------------------
// Badge, menus, shortcuts

async function updateBadge() {
  const records = Object.values(await getRecords());
  const unsorted = records.filter((r) => r.intent === 'unsorted').length;
  await chrome.action.setBadgeBackgroundColor({ color: '#2563EB' });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setBadgeText({ text: unsorted ? String(Math.min(unsorted, 999)) : '' });
  await chrome.action.setTitle({ title: unsorted ? `Nook: ${plural(unsorted, 'tab')} to sort` : 'Nook' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.records) updateBadge();
  if (changes.settings) {
    settingsCache = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    const o = changes.settings.oldValue || {};
    const n = changes.settings.newValue || {};
    if (o.digestEnabled !== n.digestEnabled || o.digestDay !== n.digestDay || o.digestHour !== n.digestHour) scheduleDigest();
  }
  if (changes.license) scheduleDigest();
});

async function openNook(hash = '') {
  const base = chrome.runtime.getURL('pages/nook.html');
  const [existing] = await chrome.tabs.query({ url: base + '*' });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true, url: base + (hash ? '#' + hash : '') });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: base + (hash ? '#' + hash : '') });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'nook-open') return openNook();
  const scope = { 'nook-tab': 'tab', 'nook-others': 'others', 'nook-window': 'window' }[info.menuItemId];
  if (scope === 'window') return askNameThenRest(tab);
  if (scope) manualArchive({ scope, tabId: tab?.id, windowId: tab?.windowId });
});

async function askNameThenRest(tab) {
  try {
    await session.set({ askWindowName: tab?.windowId });
    await chrome.action.openPopup({ windowId: tab?.windowId });
  } catch {
    await session.remove('askWindowName');
    manualArchive({ scope: 'window', windowId: tab?.windowId });
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'archive-tab') manualArchive({ scope: 'tab', tabId: tab?.id });
  if (command === 'open-sort') openNook('sort');
});

// ---------------------------------------------------------------------------
// Lifetime license (Lemon Squeezy license keys)

async function activateLicense({ key }) {
  if (!PAYMENTS.enabled) throw new Error('Lifetime purchases open soon.');
  const k = String(key || '').trim();
  if (!k) throw new Error('Paste your license key first.');
  let json = {};
  try {
    const res = await fetch('https://api.lemonsqueezy.com/v1/licenses/activate', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ license_key: k, instance_name: 'Nook for Chrome' }),
    });
    json = await res.json();
  } catch {
    throw new Error('Couldn’t reach the license server. Check your connection and try again.');
  }
  if (!json.activated) throw new Error(json.error || 'That key wasn’t accepted. Check it and try again.');
  if ((PAYMENTS.storeId && json.meta?.store_id !== PAYMENTS.storeId) ||
      (PAYMENTS.productId && json.meta?.product_id !== PAYMENTS.productId)) {
    throw new Error('That key belongs to a different product.');
  }
  await local.set({
    license: { plan: 'lifetime', source: 'lemonsqueezy', key: k, instanceId: json.instance?.id || null, activatedAt: Date.now() },
  });
  return { ok: true };
}

async function devUnlock({ on }) {
  if (!isDevBuild()) throw new Error('Only available in developer builds.');
  await local.set({ license: on ? { plan: 'lifetime', source: 'dev', activatedAt: Date.now() } : { plan: 'free' } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages from Nook's pages

const handlers = {
  archive: manualArchive,
  restore,
  assign,
  setDone,
  keep,
  deleteRecords,
  putRecords,
  importItems,
  project: projectAction,
  restoreWindow,
  window: windowAction,
  setNote,
  clearAll,
  activateLicense,
  devUnlock,
  openNook: ({ hash }) => openNook(hash),
  saveSettings: async ({ patch }) => {
    const s = await getSettings();
    const next = { ...s, ...patch };
    settingsCache = next;
    await local.set({ settings: next });
    return { ok: true };
  },
  // Developer helper: run the idle sweep now, ignoring the after-restart grace period.
  runIdleCheck: async () => {
    if (!isDevBuild()) throw new Error('Only available in developer builds.');
    return tick({ ignoreBaseline: true });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || !handlers[msg.type]) return false;
  Promise.resolve()
    .then(() => handlers[msg.type](msg))
    .then((res) => sendResponse(res ?? { ok: true }), (err) => sendResponse({ error: err.message || String(err) }));
  return true;
});

// Exposed for the developer console and tests.
globalThis.nook = { tick, autoArchive, daily, sendDigest, getAll, nextDigestTime };
