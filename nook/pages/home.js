// The Nook page: everything that's resting, grouped by why it was open.
import { INTENTS, SECTION_ORDER, FREE_LIMIT, IDLE_CHOICES, CLEAR_FADING_AFTER_DAYS, NOTE_MAX } from '../lib/constants.js';
import { getAll, send, isLifetime } from '../lib/store.js';
import { h, icon, brandMark, clear, toast, applyTheme } from '../lib/ui.js';
import { timeAgo, plural, faviconFor, monthKey, titleTokens, jaccard } from '../lib/util.js';
import { thumbView, thumbUrl } from '../lib/thumbview.js';
import { pickProject, pickerOpen, editNote, stickyNote } from './picker.js';

const DAY = 24 * 60 * 60 * 1000;
const newestFirst = (a, b) => (b.sortedAt || b.archivedAt) - (a.sortedAt || a.archivedAt);

function idleLabel(minutes) {
  const c = IDLE_CHOICES.find((x) => x.minutes === minutes);
  return c ? c.label : plural(Math.max(1, Math.round(minutes / 60)), 'hour');
}

// "Fri, Oct 16 at 8:39 PM" (with the year when it isn't this year).
function closedAt(t) {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

function sortEstimate(n) {
  const secs = Math.max(5, Math.ceil((n * 1.4) / 5) * 5);
  return secs < 60 ? `About ${secs} seconds.` : `About ${plural(Math.ceil(secs / 60), 'minute')}.`;
}

// Buying items from the same store, or with similar names, sit side by side.
function buyingClusters(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tokens = items.map((r) => titleTokens(r.title));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].domain === items[j].domain || jaccard(tokens[i], tokens[j]) >= 0.34) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((r, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const sets = [];
  const singles = [];
  for (const g of groups.values()) (g.length > 1 ? sets : singles).push(g);
  return {
    sets: sets.map((g) => ({
      label: g.every((r) => r.domain === g[0].domain) ? `From ${g[0].domain}` : 'Similar items',
      items: g,
    })),
    singles: singles.flat(),
  };
}

export function mountHome(root, { anchor = '' } = {}) {
  let data = null;
  let query = '';
  let showDone = false;
  const selected = new Set();
  let menuEl = null;
  let pendingRender = false;
  let alive = true;
  let firstRender = true;

  // ---- static chrome: top bar, content area, bulk bar

  const search = h('input', {
    type: 'search',
    class: 'search-input',
    placeholder: 'Search your tabs',
    'aria-label': 'Search your tabs',
    oninput: () => { query = search.value.trim().toLowerCase(); render(); },
  });
  const viewToggle = h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' },
    h('button', { class: 'seg-btn', 'data-view': 'grid', 'aria-label': 'Grid', title: 'Grid', onclick: () => setView('grid') }, icon('grid', 17)),
    h('button', { class: 'seg-btn', 'data-view': 'list', 'aria-label': 'List', title: 'List', onclick: () => setView('list') }, icon('list', 17)),
  );
  const themeToggle = h('div', { class: 'seg', role: 'group', 'aria-label': 'Display' },
    h('button', { class: 'seg-btn', 'data-mode': 'light', 'aria-label': 'Light display', title: 'Light', onclick: () => setTheme('light') }, icon('sun', 17)),
    h('button', { class: 'seg-btn', 'data-mode': 'dark', 'aria-label': 'Dark display', title: 'Dark', onclick: () => setTheme('dark') }, icon('moon', 16)),
  );
  const content = h('div', { class: 'home-content' });
  const nav = h('nav', { class: 'home-nav', 'aria-label': 'Sections' });
  const bulkbar = h('div', { class: 'bulkbar', hidden: true, role: 'region', 'aria-label': 'Selected tabs' });

  clear(root).append(
    h('header', { class: 'topbar' },
      h('a', { class: 'brand', href: '#' }, brandMark(26), h('span', null, 'Nook')),
      h('label', { class: 'search' }, icon('search', 17), search, h('kbd', { 'aria-hidden': 'true' }, '/')),
      h('div', { class: 'top-actions' },
        viewToggle,
        themeToggle,
        h('a', { class: 'iconbtn', href: '#settings', 'aria-label': 'Settings', title: 'Settings' }, icon('gear', 18)),
      ),
    ),
    h('div', { class: 'home' }, nav, content),
    bulkbar,
  );

  async function setView(mode) {
    data.settings.viewMode = mode;
    render();
    send('saveSettings', { patch: { viewMode: mode } });
  }

  // "System" follows the computer; the toggle shows whichever look is on screen right now.
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  function shownTheme() {
    const t = data && data.settings.theme;
    if (t === 'light' || t === 'dark') return t;
    return darkQuery.matches ? 'dark' : 'light';
  }
  function syncThemeToggle() {
    const t = shownTheme();
    themeToggle.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === t)));
  }
  function setTheme(theme) {
    data.settings.theme = theme;
    applyTheme(theme);
    syncThemeToggle();
    send('saveSettings', { patch: { theme } });
  }
  darkQuery.addEventListener('change', syncThemeToggle);

  // ---- data

  async function load() {
    data = await getAll();
    if (alive) render();
  }

  const onStorage = async (changes, area) => {
    if (area !== 'local' || !alive) return;
    data = await getAll();
    if (menuEl || pickerOpen()) { pendingRender = true; return; }
    render();
  };
  chrome.storage.onChanged.addListener(onStorage);

  const records = () => Object.values(data.records);
  const lifetime = () => isLifetime(data.license);

  function matches(r) {
    if (!query) return true;
    const hay = `${r.title} ${r.url} ${r.project || ''} ${r.note || ''}`.toLowerCase();
    return query.split(/\s+/).every((t) => hay.includes(t));
  }

  // ---- actions

  async function windowId() {
    return (await chrome.windows.getCurrent()).id;
  }

  async function openItems(ids, { remove = false, asGroup = false, title, color } = {}) {
    try {
      await send('restore', { ids, remove, asGroup, title, color, windowId: await windowId() });
    } catch (e) {
      toast(e.message);
    }
  }

  async function moveItems(ids, intent) {
    let project = null;
    if (intent === 'research' && lifetime()) {
      project = await pickProject(data.projects);
      if (project === undefined) return flush();
    }
    await send('assign', { ids, intent, project });
    selected.clear();
    toast(`Moved ${plural(ids.length, 'tab')} to ${INTENTS[intent].label}.`);
    flush();
  }

  async function deleteItems(ids, label) {
    const before = ids.map((id) => data.records[id]).filter(Boolean);
    await send('deleteRecords', { ids });
    ids.forEach((id) => selected.delete(id));
    toast(label || `Deleted ${plural(before.length, 'tab')}.`, {
      action: 'Undo',
      onAction: () => send('putRecords', { records: before }),
      timeout: 6000,
    });
  }

  async function noteFor(r) {
    const text = await editNote(r, NOTE_MAX);
    if (text !== undefined && text !== (r.note || '')) {
      try { await send('setNote', { id: r.id, note: text }); } catch (e) { toast(e.message); }
    }
    flush();
  }

  function flush() {
    if (pendingRender) { pendingRender = false; render(); }
  }

  // ---- menu

  function closeMenu() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('pointerdown', onOutside, true);
    flush();
  }
  const onOutside = (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); };

  function openMenu(anchorEl, entries) {
    closeMenu();
    menuEl = h('div', { class: 'menu', role: 'menu' },
      entries.filter(Boolean).map((en) => {
        if (en === '-') return h('div', { class: 'menu-sep', role: 'separator' });
        if (en.heading) return h('div', { class: 'menu-heading' }, en.heading);
        return h('button', {
          class: 'menu-item' + (en.danger ? ' danger' : ''),
          role: 'menuitem',
          'data-intent': en.intent,
          onclick: () => { closeMenu(); en.run(); },
        }, en.intent ? h('span', { class: 'dot' }) : en.icon ? icon(en.icon, 16) : null, en.label);
      }),
    );
    document.body.append(menuEl);
    const r = anchorEl.getBoundingClientRect();
    const w = menuEl.offsetWidth;
    const hgt = menuEl.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), innerWidth - w - 8);
    const top = r.bottom + 6 + hgt > innerHeight ? Math.max(8, r.top - hgt - 6) : r.bottom + 6;
    menuEl.style.left = `${left + scrollX}px`;
    menuEl.style.top = `${top + scrollY}px`;
    menuEl.querySelector('.menu-item')?.focus();
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  }

  function itemMenu(r, btn) {
    const moves = Object.values(INTENTS)
      .filter((i) => i.id !== 'window' && (i.id !== r.intent || (i.id === 'research' && lifetime())))
      .map((i) => ({ label: i.id === r.intent ? 'Change project' : i.label, intent: i.id, run: () => moveItems([r.id], i.id) }));
    openMenu(btn, [
      { label: 'Open and remove from Nook', icon: 'open', run: () => openItems([r.id], { remove: true }) },
      { label: r.note ? 'Edit note' : 'Add a note', icon: 'note', run: () => noteFor(r) },
      r.status === 'fading' && { label: 'Keep it', icon: 'keep', run: () => send('keep', { ids: [r.id] }) },
      '-',
      { heading: 'Move to' },
      ...moves,
      '-',
      { label: 'Delete', icon: 'trash', danger: true, run: () => deleteItems([r.id]) },
    ]);
  }

  // ---- item views

  function toggleSelect(id, on) {
    if (on) selected.add(id); else selected.delete(id);
    render();
  }

  function selectBox(r) {
    return h('label', { class: 'select', title: 'Select' },
      h('input', {
        type: 'checkbox',
        checked: selected.has(r.id),
        'aria-label': `Select ${r.title}`,
        onchange: (e) => toggleSelect(r.id, e.target.checked),
      }),
      h('span', { class: 'select-box' }, icon('check', 13)));
  }

  function doneToggle(r) {
    const done = r.status === 'done';
    return h('button', {
      class: 'done-toggle' + (done ? ' is-done' : ''),
      'aria-pressed': String(done),
      'aria-label': done ? 'Mark as not done' : 'Mark as done',
      title: done ? 'Mark as not done' : 'Mark as done',
      onclick: () => send('setDone', { id: r.id, done: !done }),
    }, icon('check', 13));
  }

  function itemTitle(r) {
    return h('a', {
      class: 'item-title',
      href: r.url,
      title: r.title,
      onclick: (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let the browser open it normally
        e.preventDefault();
        openItems([r.id]);
      },
    }, r.title);
  }

  function whenLine(r) {
    if (r.status === 'fading') {
      const days = Math.max(1, Math.ceil((r.fadingAt + CLEAR_FADING_AFTER_DAYS * DAY - Date.now()) / DAY));
      return `Clears in ${plural(days, 'day')}`;
    }
    if (r.status === 'done' && r.doneAt) return `Done ${timeAgo(r.doneAt)}`;
    return timeAgo(r.archivedAt);
  }

  function actionButtons(r) {
    return h('div', { class: 'item-actions' },
      r.status === 'fading' && h('button', { class: 'chip-btn', onclick: () => send('keep', { ids: [r.id] }) }, icon('keep', 14), 'Keep'),
      !r.note && h('button', { class: 'chip-btn icon-only', 'aria-label': 'Add a note', title: 'Add a note', onclick: () => noteFor(r) }, icon('note', 15)),
      h('button', { class: 'chip-btn', onclick: () => openItems([r.id]), title: 'Open this tab again. It stays in Nook.' }, icon('open', 14), 'Open'),
      h('button', { class: 'chip-btn icon-only', 'aria-label': 'More actions', title: 'More', onclick: (e) => itemMenu(r, e.currentTarget) }, icon('more', 16)),
    );
  }

  function card(r) {
    return h('article', { class: 'item' + (selected.has(r.id) ? ' is-selected' : '') + (r.status === 'done' ? ' is-done' : ''), 'data-intent': r.intent },
      h('div', { class: 'item-thumb-wrap' },
        thumbView(r, { className: 'item-thumb', faviconSize: 32 }),
        r.note && stickyNote(r.note, () => noteFor(r)),
        selectBox(r),
        actionButtons(r),
      ),
      h('div', { class: 'item-text' },
        h('div', { class: 'item-title-row' }, r.intent === 'todo' && doneToggle(r), itemTitle(r)),
        h('div', { class: 'item-meta' },
          h('img', { src: faviconFor(r.url, 16), width: 14, height: 14, alt: '' }),
          h('span', { class: 'item-domain' }, r.domain),
          h('span', { class: 'item-when' }, whenLine(r))),
      ),
    );
  }

  function row(r) {
    return h('div', { class: 'row' + (selected.has(r.id) ? ' is-selected' : '') + (r.status === 'done' ? ' is-done' : ''), 'data-intent': r.intent },
      selectBox(r),
      r.intent === 'todo' ? doneToggle(r) : h('img', { class: 'row-fav', src: faviconFor(r.url, 16), width: 16, height: 16, alt: '' }),
      h('div', { class: 'row-main' }, itemTitle(r),
        r.note && h('button', { class: 'row-note', type: 'button', title: 'Edit note', onclick: () => noteFor(r) }, icon('note', 13), r.note)),
      h('span', { class: 'row-domain' }, r.domain),
      h('span', { class: 'row-when' }, whenLine(r)),
      actionButtons(r),
    );
  }

  function itemsView(items) {
    const list = data.settings.viewMode === 'list';
    return h('div', { class: list ? 'rows' : 'grid' }, items.map(list ? row : card));
  }

  // ---- sections

  function sectionHead(intentId, title, count, actions, level = 2) {
    return h('div', { class: level === 2 ? 'section-head' : 'sub-head' },
      h(level === 2 ? 'h2' : 'h3', { class: level === 2 ? 'section-title' : 'sub-title' },
        level === 2 && h('span', { class: 'dot', 'data-intent': intentId }), title),
      h('span', { class: 'count' }, String(count)),
      h('div', { class: 'head-actions' }, actions),
    );
  }

  function groupActions(items, title, color, deleteLabel) {
    const ids = items.map((r) => r.id);
    return [
      h('button', { class: 'btn quiet small', onclick: () => openItems(ids, { asGroup: true, title, color }) }, icon('open', 14), 'Open all'),
      h('button', { class: 'btn quiet small', onclick: () => deleteItems(ids, deleteLabel) }, icon('trash', 14), 'Delete all'),
    ];
  }

  function section(id, children, count) {
    return h('section', { class: 'section', id: `sec-${id}`, 'data-intent': id }, children);
  }

  function todoSection(items) {
    const open = items.filter((r) => r.status !== 'done').sort(newestFirst);
    const done = items.filter((r) => r.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    if (!open.length && !done.length) return null;
    return section('todo', [
      sectionHead('todo', 'To do', open.length, [
        done.length > 0 && h('button', { class: 'btn quiet small', onclick: () => { showDone = !showDone; render(); } },
          showDone ? 'Hide done' : `Show done (${done.length})`),
        open.length > 0 && groupActions(open, 'To do', INTENTS.todo.groupColor)[0],
      ]),
      open.length ? itemsView(open) : h('p', { class: 'empty-line' }, 'Everything here is done.'),
      showDone && done.length > 0 && h('div', { class: 'sub' },
        sectionHead('todo', 'Done', done.length, [
          h('button', { class: 'btn quiet small', onclick: () => deleteItems(done.map((r) => r.id), `Cleared ${plural(done.length, 'done tab')}.`) }, icon('trash', 14), 'Clear done'),
        ], 3),
        itemsView(done)),
    ]);
  }

  function windowsSection(items) {
    if (!items.length) return null;
    const byWindow = new Map();
    items.forEach((r) => {
      if (!byWindow.has(r.savedWindow)) byWindow.set(r.savedWindow, []);
      byWindow.get(r.savedWindow).push(r);
    });
    const blocks = [...byWindow.entries()]
      .map(([id, list]) => ({ id, list: list.sort((a, b) => (a.windowIndex ?? 0) - (b.windowIndex ?? 0)), info: data.windows[id] || { id, name: 'Saved window', savedAt: list[0].archivedAt } }))
      .sort((a, b) => b.info.savedAt - a.info.savedAt);
    return section('window', [
      sectionHead('window', 'Windows', blocks.length, []),
      h('p', { class: 'section-hint' }, 'Whole windows you rested at once. Reopen one exactly as it was, tab groups included.'),
      blocks.map(({ id, list, info }) => h('div', { class: 'saved-window' },
        h('div', { class: 'saved-window-head' },
          h('div', { class: 'saved-window-title' },
            h('h3', { class: 'sub-title' }, info.name),
            h('span', { class: 'count' }, `${plural(list.length, 'tab')}. Closed ${closedAt(info.savedAt)}`)),
          h('div', { class: 'head-actions' },
            h('button', { class: 'btn primary small', onclick: () => send('restoreWindow', { id }).catch((e) => toast(e.message)) }, icon('window', 15), 'Open in new window'),
            h('button', { class: 'btn quiet small icon-only', 'aria-label': `More for ${info.name}`, onclick: (e) => openMenu(e.currentTarget, [
              { label: 'Open and remove from Nook', icon: 'open', run: () => send('restoreWindow', { id, remove: true }) },
              { label: 'Rename window', icon: 'window', run: () => renameWindow(id, info.name) },
              '-',
              { label: 'Delete window', icon: 'trash', danger: true, run: () => deleteWindow(id, info, list) },
            ]) }, icon('more', 16)))),
        h('div', { class: 'compare-row' }, list.map(card)))),
    ]);
  }

  async function renameWindow(id, name) {
    const next = prompt('Rename window', name);
    if (!next || next.trim() === name) return;
    try { await send('window', { action: 'rename', id, name: next.trim() }); } catch (e) { toast(e.message); }
  }

  async function deleteWindow(id, info, list) {
    const before = list.map((r) => ({ ...r }));
    await send('window', { action: 'delete', id });
    toast(`Deleted \u201c${info.name}\u201d.`, {
      action: 'Undo',
      timeout: 6000,
      onAction: async () => {
        await send('window', { action: 'put', entry: info });
        await send('putRecords', { records: before });
      },
    });
  }

  function unsortedSection(items) {
    if (!items.length) return null;
    items.sort(newestFirst);
    return section('unsorted', [
      sectionHead('unsorted', 'Unsorted', items.length, [
        h('a', { class: 'btn quiet small', href: '#sort' }, 'Sort one by one'),
        ...groupActions(items, 'Unsorted', INTENTS.unsorted.groupColor),
      ]),
      h('p', { class: 'section-hint' }, 'Select a few and give them a reason together, or sort them one by one.'),
      itemsView(items),
    ]);
  }

  function readLaterSection(items) {
    const waiting = items.filter((r) => r.status !== 'fading').sort(newestFirst);
    const fading = items.filter((r) => r.status === 'fading').sort((a, b) => a.fadingAt - b.fadingAt);
    if (!waiting.length && !fading.length) return null;
    return section('read_later', [
      sectionHead('read_later', 'Read later', waiting.length + fading.length, groupActions([...waiting, ...fading], 'Read later', INTENTS.read_later.groupColor)),
      waiting.length > 0 && itemsView(waiting),
      fading.length > 0 && h('div', { class: 'sub', id: 'sec-fading' },
        sectionHead('read_later', 'Fading', fading.length, [
          h('button', { class: 'btn quiet small', onclick: () => send('keep', { ids: fading.map((r) => r.id) }) }, icon('keep', 14), 'Keep all'),
        ], 3),
        h('p', { class: 'section-hint' }, `Not opened in a month. Nook clears these after ${CLEAR_FADING_AFTER_DAYS} days unless you keep them.`),
        itemsView(fading)),
    ]);
  }

  function buyingSection(items) {
    if (!items.length) return null;
    items.sort(newestFirst);
    const { sets, singles } = buyingClusters(items);
    return section('buying', [
      sectionHead('buying', 'Buying', items.length, groupActions(items, 'Buying', INTENTS.buying.groupColor)),
      sets.map((s) => h('div', { class: 'compare' },
        h('div', { class: 'compare-head' },
          h('span', { class: 'compare-label' }, s.label),
          h('span', { class: 'count' }, String(s.items.length)),
          h('button', { class: 'btn quiet small', onclick: () => openItems(s.items.map((r) => r.id), { asGroup: true, title: s.label.replace(/^From /, ''), color: INTENTS.buying.groupColor }) }, icon('open', 14), 'Open side by side')),
        h('div', { class: 'compare-row' }, s.items.map(card)))),
      singles.length > 0 && itemsView(singles),
    ]);
  }

  function projectBlock(name, items, finished) {
    const ids = items.map((r) => r.id);
    const title = name || 'No project';
    const more = (btn) => openMenu(btn, [
      { label: 'Rename project', icon: 'folder', run: () => renameProject(name) },
      '-',
      { label: 'Delete project and its tabs', icon: 'trash', danger: true, run: () => deleteProject(name, items) },
    ]);
    return h('div', { class: 'sub' + (finished ? ' is-finished' : '') },
      sectionHead('research', title, items.length, [
        h('button', { class: 'btn quiet small', onclick: () => openItems(ids, { asGroup: true, title, color: INTENTS.research.groupColor }) }, icon('open', 14), 'Open all'),
        name && h('button', { class: 'btn quiet small', onclick: () => send('project', { action: 'archive', name, archived: !finished }) },
          finished ? 'Reopen project' : icon('check', 14), finished ? null : 'Mark finished'),
        name ? h('button', { class: 'btn quiet small icon-only', 'aria-label': `More for ${name}`, onclick: (e) => more(e.currentTarget) }, icon('more', 16))
          : h('button', { class: 'btn quiet small', onclick: () => deleteItems(ids) }, icon('trash', 14), 'Delete all'),
      ], 3),
      itemsView(items.sort(newestFirst)),
    );
  }

  async function renameProject(name) {
    const next = prompt('Rename project', name);
    if (!next || next.trim() === name) return;
    try { await send('project', { action: 'rename', name, newName: next.trim() }); } catch (e) { toast(e.message); }
  }

  async function deleteProject(name, items) {
    const before = items.map((r) => ({ ...r }));
    const project = data.projects[name];
    await send('project', { action: 'delete', name });
    toast(`Deleted “${name}” and ${plural(items.length, 'tab')}.`, {
      action: 'Undo',
      timeout: 6000,
      onAction: async () => {
        await send('putRecords', { records: before });
        if (project) await send('project', { action: 'create', name });
        if (project?.archived) await send('project', { action: 'archive', name, archived: true });
      },
    });
  }

  function researchSection(items) {
    if (!items.length) return null;
    const byProject = new Map();
    items.forEach((r) => {
      const k = r.project && data.projects[r.project] ? r.project : '';
      if (!byProject.has(k)) byProject.set(k, []);
      byProject.get(k).push(r);
    });
    const names = [...byProject.keys()].filter(Boolean)
      .sort((a, b) => (data.projects[b].createdAt || 0) - (data.projects[a].createdAt || 0));
    const active = names.filter((n) => !data.projects[n].archived);
    const finished = names.filter((n) => data.projects[n].archived);
    return section('research', [
      sectionHead('research', 'Research', items.length, []),
      active.map((n) => projectBlock(n, byProject.get(n), false)),
      byProject.has('') && (active.length || finished.length ? projectBlock('', byProject.get(''), false) : itemsView(byProject.get('').sort(newestFirst))),
      finished.length > 0 && h('details', { class: 'finished' },
        h('summary', null, `Finished projects (${finished.length})`),
        finished.map((n) => projectBlock(n, byProject.get(n), true))),
    ]);
  }

  function referenceSection(items) {
    if (!items.length) return null;
    items.sort(newestFirst);
    return section('reference', [
      sectionHead('reference', 'Reference', items.length, groupActions(items, 'Reference', INTENTS.reference.groupColor)),
      itemsView(items),
    ]);
  }

  // ---- hero and notes

  function deckPreview(unsorted) {
    const top = unsorted.slice(0, 3);
    const deck = h('div', { class: 'mini-deck', 'aria-hidden': 'true' },
      top.map((r, i) => {
        const c = h('span', { class: `mini-card c${i}` });
        thumbUrl(r.thumbnailKey).then((url) => {
          if (url) c.style.backgroundImage = `url("${url}")`;
          else c.append(h('img', { src: faviconFor(r.url, 32), width: 20, height: 20, alt: '' }));
        });
        return c;
      }));
    return deck;
  }

  function hero(all) {
    const total = all.length;
    const unsorted = all.filter((r) => r.intent === 'unsorted');
    const tidied = data.stats.tidied?.[monthKey()] || 0;
    return h('section', { class: 'hero' },
      h('h1', { class: 'hero-title' }, total
        ? `${plural(total, 'tab')} ${total === 1 ? 'is' : 'are'} resting in Nook.`
        : 'Nothing is resting in Nook yet.'),
      h('p', { class: 'hero-sub' }, total
        ? (tidied ? `You’ve tidied ${plural(tidied, 'tab')} this month.` : 'Find any of them again in a click.')
        : `Tabs you haven’t looked at for ${idleLabel(data.settings.idleMinutes)} will rest here. To try it now, click the Nook icon and choose “Rest other tabs”.`),
      unsorted.length > 0
        ? h('a', { class: 'sort-prompt', href: '#sort' },
            deckPreview(unsorted),
            h('span', { class: 'sort-prompt-text' },
              h('strong', null, `You have ${plural(unsorted.length, 'tab')} to sort.`),
              h('span', null, sortEstimate(unsorted.length))),
            h('span', { class: 'btn primary' }, 'Sort tabs'))
        : total > 0 && h('p', { class: 'quiet-note' }, 'Nothing to sort. Enjoy the quiet.'),
    );
  }

  function notes(all) {
    const out = [];
    if (!data.settings.welcomeDismissed) {
      out.push(h('div', { class: 'note welcome' },
        h('div', null,
          h('strong', null, 'Nook is set up.'),
          h('p', null, `Tabs you haven’t looked at for ${idleLabel(data.settings.idleMinutes)} rest here, with a picture so they’re easy to spot. The tab you’re on, pinned tabs and tabs playing sound are never closed. Everything stays on this computer.`)),
        h('div', { class: 'note-actions' },
          h('a', { class: 'btn small', href: '#settings' }, 'Change timing'),
          h('button', { class: 'btn primary small', onclick: () => { data.settings.welcomeDismissed = true; send('saveSettings', { patch: { welcomeDismissed: true } }); render(); } }, 'Got it')),
      ));
    }
    if (!lifetime() && all.length >= FREE_LIMIT - 5) {
      const full = all.length >= FREE_LIMIT;
      out.push(h('div', { class: 'note limit' },
        h('div', null,
          h('strong', null, full ? 'Nook is full.' : `Nook is holding ${all.length} of ${FREE_LIMIT} tabs.`),
          h('p', null, full
            ? `The free version holds ${FREE_LIMIT} tabs, so idle tabs stay open for now. Nothing has been deleted.`
            : `The free version holds ${FREE_LIMIT}. After that, idle tabs stay open until you make room.`)),
        h('div', { class: 'note-actions' }, h('a', { class: 'btn small', href: '#settings/lifetime' }, 'See Nook Lifetime')),
      ));
    }
    return out;
  }

  // ---- nav and bulk bar

  function renderNav(groups) {
    const items = SECTION_ORDER.map((id) => {
      const n = groups[id].length;
      return h('a', { class: 'nav-item' + (n ? '' : ' is-empty'), href: `#${id}`, 'data-intent': id, onclick: (e) => { e.preventDefault(); scrollToSection(id); } },
        h('span', { class: 'dot' }), INTENTS[id].label, h('span', { class: 'count' }, n ? String(n) : ''));
    });
    clear(nav).append(h('div', { class: 'nav-list' }, items));
  }

  function scrollToSection(id) {
    const el = document.getElementById(`sec-${id}`);
    if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }

  function renderBulk() {
    const ids = [...selected].filter((id) => data.records[id]);
    bulkbar.hidden = ids.length === 0;
    if (!ids.length) return;
    clear(bulkbar).append(
      h('span', { class: 'bulk-count' }, `${ids.length} selected`),
      h('div', { class: 'bulk-moves', role: 'group', 'aria-label': 'Give them a reason' },
        Object.values(INTENTS).filter((i) => i.id !== 'unsorted' && i.id !== 'window').map((i) =>
          h('button', { class: 'bulk-move', 'data-intent': i.id, onclick: () => moveItems(ids, i.id) }, h('span', { class: 'dot' }), i.label))),
      h('span', { class: 'bulk-sep' }),
      h('button', { class: 'btn quiet small', onclick: () => { openItems(ids, { asGroup: true, title: 'From Nook', color: 'purple' }); selected.clear(); render(); } }, icon('open', 14), 'Open as group'),
      h('button', { class: 'btn quiet small danger', onclick: () => deleteItems(ids) }, icon('trash', 14), 'Delete'),
      h('button', { class: 'iconbtn', 'aria-label': 'Clear selection', title: 'Clear selection', onclick: () => { selected.clear(); render(); } }, icon('x', 16)),
    );
  }

  // ---- render

  function render() {
    if (!alive || !data) return;
    const y = scrollY;
    const all = records();
    for (const id of [...selected]) if (!data.records[id]) selected.delete(id);

    viewToggle.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === (data.settings.viewMode || 'grid'))));
    syncThemeToggle();

    const visible = all.filter(matches);
    const groups = Object.fromEntries(SECTION_ORDER.map((id) => [id, []]));
    visible.forEach((r) => (groups[r.intent] || groups.unsorted).push(r));
    renderNav(groups);

    const sections = [
      todoSection(groups.todo),
      windowsSection(groups.window),
      unsortedSection(groups.unsorted),
      readLaterSection(groups.read_later),
      buyingSection(groups.buying),
      researchSection(groups.research),
      referenceSection(groups.reference),
    ].filter(Boolean);

    clear(content).append(...[
      !query && hero(all),
      ...(!query ? notes(all) : []),
      query && h('p', { class: 'search-summary' }, visible.length
        ? `${plural(visible.length, 'tab')} match “${search.value.trim()}”.`
        : `No tabs match “${search.value.trim()}”.`,
        h('button', { class: 'btn quiet small', onclick: () => { search.value = ''; query = ''; render(); } }, 'Clear search')),
      ...sections,
    ].filter(Boolean));

    renderBulk();
    if (firstRender) {
      firstRender = false;
      if (anchor && anchor !== 'welcome') requestAnimationFrame(() => scrollToSection(anchor));
    } else {
      scrollTo(0, y);
    }
  }

  // ---- keyboard

  const onKey = (e) => {
    if (pickerOpen()) return;
    const typing = e.target.closest?.('input, textarea, select');
    if (e.key === '/' && !typing) { e.preventDefault(); search.focus(); return; }
    if (e.key === 'Escape') {
      if (menuEl) { closeMenu(); return; }
      if (selected.size) { selected.clear(); render(); return; }
      if (query) { search.value = ''; query = ''; render(); search.blur(); }
    }
  };
  document.addEventListener('keydown', onKey);

  load();

  return () => {
    alive = false;
    closeMenu();
    chrome.storage.onChanged.removeListener(onStorage);
    document.removeEventListener('keydown', onKey);
    darkQuery.removeEventListener('change', syncThemeToggle);
  };
}
