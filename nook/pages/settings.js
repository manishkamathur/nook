// Settings: timing, sites, reminders, look, data, and Nook Lifetime.
import {
  INTENTS, SECTION_ORDER, IDLE_CHOICES, DAYS, PAYMENTS, FREE_LIMIT, MONETIZED,
  FADE_AFTER_DAYS, CLEAR_FADING_AFTER_DAYS,
} from '../lib/constants.js';
import { getAll, send, isLifetime, isDevBuild } from '../lib/store.js';
import { h, icon, brandMark, clear, toast, applyTheme } from '../lib/ui.js';
import { parseDomainList, plural } from '../lib/util.js';

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6); // 6 am to 10 pm

function hourLabel(hr) {
  const d = new Date();
  d.setHours(hr, 0, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const closedAt = (t) => {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};

const stamp = () => new Date().toISOString().slice(0, 10);

function toJSON(data) {
  const keep = ['url', 'title', 'intent', 'project', 'status', 'note', 'openedAt', 'lastViewedAt', 'archivedAt', 'sortedAt', 'doneAt', 'fadingAt', 'savedWindow', 'windowIndex', 'groupName', 'groupColor'];
  const items = Object.values(data.records).map((r) => Object.fromEntries(keep.filter((k) => r[k] != null && r[k] !== '').map((k) => [k, r[k]])));
  return JSON.stringify({
    app: 'nook',
    version: 1,
    exportedAt: new Date().toISOString(),
    items,
    projects: Object.values(data.projects),
    windows: Object.values(data.windows),
  }, null, 2);
}

function toMarkdown(data) {
  const list = Object.values(data.records);
  const link = (r) => `[${r.title.replace(/[[\]]/g, '')}](${r.url})`;
  const note = (r) => (r.note ? `\n  > ${r.note.replace(/\n/g, ' ')}` : '');
  const out = [`# Nook export, ${new Date().toLocaleDateString(undefined, { dateStyle: 'long' })}`, ''];
  for (const id of SECTION_ORDER) {
    const items = list.filter((r) => r.intent === id);
    if (!items.length) continue;
    out.push(`## ${INTENTS[id].label}`, '');
    if (id === 'window') {
      const byWin = new Map();
      items.forEach((r) => { if (!byWin.has(r.savedWindow)) byWin.set(r.savedWindow, []); byWin.get(r.savedWindow).push(r); });
      for (const [wid, rs] of byWin) {
        const w = data.windows[wid];
        out.push(`### ${w ? w.name : 'Saved window'}${w ? ` (closed ${closedAt(w.savedAt)})` : ''}`, '');
        rs.sort((a, b) => (a.windowIndex ?? 0) - (b.windowIndex ?? 0)).forEach((r) => out.push(`- ${link(r)}${note(r)}`));
        out.push('');
      }
    } else if (id === 'research') {
      const byProject = new Map();
      items.forEach((r) => { const k = r.project || 'No project'; if (!byProject.has(k)) byProject.set(k, []); byProject.get(k).push(r); });
      for (const [name, rs] of byProject) {
        out.push(`### ${name}`, '');
        rs.forEach((r) => out.push(`- ${link(r)}${note(r)}`));
        out.push('');
      }
    } else {
      items.forEach((r) => out.push(`- ${id === 'todo' ? (r.status === 'done' ? '[x] ' : '[ ] ') : ''}${link(r)}${note(r)}`));
      out.push('');
    }
  }
  return out.join('\n');
}

// Accepts a Nook JSON export, or OneTab's "url | title" text export.
function parseImport(text) {
  try {
    const json = JSON.parse(text);
    const items = Array.isArray(json) ? json : json.items || Object.values(json.records || {});
    if (Array.isArray(items)) return { items, projects: json.projects || [], windows: json.windows || [] };
  } catch { /* not JSON, try OneTab */ }
  const items = text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line))
    .map((line) => {
      const i = line.indexOf(' | ');
      return i === -1 ? { url: line } : { url: line.slice(0, i).trim(), title: line.slice(i + 3).trim() };
    });
  return { items, projects: [], windows: [] };
}

export function mountSettings(root, { anchor = '' } = {}) {
  let data = null;
  let alive = true;

  const save = async (patch) => {
    Object.assign(data.settings, patch);
    try { await send('saveSettings', { patch }); } catch (e) { toast(e.message); }
  };

  // ---- small building blocks

  const row = (label, hint, control, { disabled = false } = {}) =>
    h('div', { class: 'set-row' + (disabled ? ' is-disabled' : '') },
      h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, label), hint && h('span', { class: 'set-hint' }, hint)),
      h('div', { class: 'set-control' }, control));

  const toggle = (checked, onChange, label, disabled = false) =>
    h('input', { type: 'checkbox', class: 'switch', checked, disabled, 'aria-label': label, onchange: (e) => onChange(e.target.checked) });

  const select = (value, options, onChange, label, disabled = false) =>
    h('select', { class: 'set-select', 'aria-label': label, disabled, onchange: (e) => onChange(e.target.value) },
      options.map(([v, text]) => h('option', { value: String(v), selected: String(v) === String(value) }, text)));

  const card = (id, title, children, badge) =>
    h('section', { class: 'set-card', id: `set-${id}` },
      h('h2', { class: 'set-title' }, title, badge && h('span', { class: 'lifetime-badge' }, badge)),
      children);

  function domainsBox(key, label, hint, placeholder) {
    const status = h('span', { class: 'set-saved', role: 'status' });
    const area = h('textarea', { class: 'set-textarea', rows: 4, placeholder, 'aria-label': label, spellcheck: 'false' });
    area.value = (data.settings[key] || []).join('\n');
    area.addEventListener('blur', async () => {
      const list = parseDomainList(area.value);
      area.value = list.join('\n');
      if (list.join() === (data.settings[key] || []).join()) return;
      await save({ [key]: list });
      status.textContent = 'Saved';
      setTimeout(() => { status.textContent = ''; }, 1600);
    });
    return h('div', { class: 'set-block' },
      h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, label), h('span', { class: 'set-hint' }, hint)),
      area,
      status);
  }

  // ---- sections

  function timing() {
    const s = data.settings;
    const idleOptions = IDLE_CHOICES.map((c) => [c.minutes, c.label]);
    if (!IDLE_CHOICES.some((c) => c.minutes === s.idleMinutes)) idleOptions.unshift([s.idleMinutes, plural(s.idleMinutes, 'minute')]);
    const cap = h('input', {
      type: 'number', class: 'set-number', min: 5, max: 200, value: s.maxTabs, disabled: !s.maxTabsEnabled, 'aria-label': 'Most tabs to keep open',
      onchange: (e) => {
        const n = Math.min(200, Math.max(5, Math.round(Number(e.target.value) || 20)));
        e.target.value = n;
        save({ maxTabs: n });
      },
    });
    return card('timing', 'When tabs rest', [
      row('Rest tabs I haven’t looked at for', 'Counted only while you’re using the browser, so a night away doesn’t sweep everything up.',
        select(s.idleMinutes, idleOptions, (v) => save({ idleMinutes: Number(v) }), 'Idle time')),
      row('Keep at most this many tabs open', 'When you go over, the tabs you looked at longest ago rest first.',
        h('div', { class: 'inline' }, cap, toggle(s.maxTabsEnabled, (on) => { cap.disabled = !on; save({ maxTabsEnabled: on }); }, 'Limit open tabs'))),
      h('p', { class: 'set-note' }, 'The tab you’re on, pinned tabs and tabs playing sound are never closed.'),
    ]);
  }

  function sites() {
    return card('sites', 'Sites', [
      domainsBox('neverCloseDomains', 'Never close these sites', 'One per line, like zoom.us. Nook leaves their tabs open.', 'meet.google.com\nzoom.us'),
      domainsBox('noScreenshotDomains', 'No thumbnails for these sites', 'Their tabs are still saved, just without a picture.', 'yourbank.com'),
    ]);
  }

  function reminders() {
    const s = data.settings;
    const locked = !isLifetime(data.license);
    return card('reminders', 'Reminders', [
      row('Weekly Read later reminder', 'A notification listing what you saved to read.',
        h('div', { class: 'inline' },
          select(s.digestDay, DAYS.map((d, i) => [i, d]), (v) => save({ digestDay: Number(v) }), 'Reminder day', locked || !s.digestEnabled),
          select(s.digestHour, HOURS.map((hr) => [hr, hourLabel(hr)]), (v) => save({ digestHour: Number(v) }), 'Reminder time', locked || !s.digestEnabled),
          toggle(s.digestEnabled && !locked, (on) => { save({ digestEnabled: on }); render(); }, 'Weekly reminder', locked)),
        { disabled: locked }),
      row('Let unread tabs fade', `Off unless you turn it on. Read later tabs not opened in ${FADE_AFTER_DAYS} days start fading; Nook tells you, then clears them ${CLEAR_FADING_AFTER_DAYS} days later.`,
        toggle(s.expiryEnabled && !locked, (on) => save({ expiryEnabled: on }), 'Let unread tabs fade', locked),
        { disabled: locked }),
      locked && h('p', { class: 'set-note' }, 'Reminders and fading come with Nook Lifetime.'),
    ], locked ? 'Lifetime' : null);
  }

  function appearance() {
    const s = data.settings;
    const themeBtn = (value, label) => h('button', {
      class: 'seg-btn wide',
      'aria-pressed': String((s.theme || 'system') === value),
      onclick: () => { applyTheme(value); save({ theme: value }); render(); },
    }, label);
    return card('appearance', 'Look and feel', [
      row('Theme', null, h('div', { class: 'seg', role: 'group', 'aria-label': 'Theme' },
        themeBtn('system', 'System'), themeBtn('light', 'Light'), themeBtn('dark', 'Dark'))),
      row('Show Nook when I open a new tab', 'Your resting tabs, one new tab away.',
        toggle(s.newTabOverride, (on) => save({ newTabOverride: on }), 'Show Nook on new tabs')),
      row('Layout', null, h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' },
        ['grid', 'list'].map((v) => h('button', {
          class: 'seg-btn wide',
          'aria-pressed': String((s.viewMode || 'grid') === v),
          onclick: () => { save({ viewMode: v }); render(); },
        }, v === 'grid' ? 'Grid' : 'List')))),
    ]);
  }

  function dataCard() {
    const total = Object.keys(data.records).length;
    const locked = !isLifetime(data.license);
    const file = h('input', {
      type: 'file', accept: '.json,.txt,application/json,text/plain', hidden: true,
      onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const parsed = parseImport(await f.text());
        if (!parsed.items.length) { toast('That file has no links Nook can read.'); return; }
        try {
          const { added, skipped } = await send('importItems', parsed);
          toast(`Imported ${plural(added, 'tab')}.` + (skipped ? ` ${skipped} skipped (already in Nook, not a web page, or over the free limit).` : ''), { timeout: 6000 });
        } catch (err) { toast(err.message); }
      },
    });
    return card('data', 'Your data', [
      h('p', { class: 'set-note top' }, `Everything stays on this computer. Nook is holding ${plural(total, 'tab')}.`),
      row('Export', 'JSON brings everything back into Nook. Markdown is easy to read or paste into notes.',
        h('div', { class: 'inline' },
          h('button', { class: 'btn small', disabled: locked, onclick: () => download(`nook-${stamp()}.json`, toJSON(data), 'application/json') }, 'Export JSON'),
          h('button', { class: 'btn small', disabled: locked, onclick: () => download(`nook-${stamp()}.md`, toMarkdown(data), 'text/markdown') }, 'Export Markdown')),
        { disabled: locked }),
      locked && h('p', { class: 'set-note' }, 'Export comes with Nook Lifetime.'),
      row('Import', 'A Nook export, or OneTab’s “Export URLs” text. Imported tabs land in Unsorted.',
        h('div', { class: 'inline' }, file, h('button', { class: 'btn small', onclick: () => file.click() }, 'Choose file'))),
      row('Clear everything', 'Deletes every saved tab, note, project, saved window and thumbnail. Settings stay.',
        h('button', { class: 'btn small danger', disabled: total === 0 && !Object.keys(data.windows).length, onclick: confirmClear }, icon('trash', 14), 'Clear everything')),
    ]);
  }

  function confirmClear() {
    const total = Object.keys(data.records).length;
    const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } },
      h('div', { class: 'modal', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'clear-title' },
        h('h2', { id: 'clear-title', class: 'modal-title' }, 'Clear everything in Nook?'),
        h('p', { class: 'set-hint' }, `This deletes ${plural(total, 'saved tab')} and their notes, projects, saved windows and thumbnails from this computer. It can’t be undone.`),
        h('div', { class: 'note-buttons end' },
          h('button', { class: 'btn quiet small', onclick: () => backdrop.remove() }, 'Cancel'),
          h('button', { class: 'btn small danger-fill', onclick: async () => {
            backdrop.remove();
            await send('clearAll');
            toast('Nook is empty.');
          } }, 'Clear everything'))));
    document.body.append(backdrop);
    backdrop.querySelector('.btn.quiet').focus();
  }

  function lifetimeCard() {
    const lic = data.license || { plan: 'free' };
    const has = isLifetime(lic);
    const dev = isDevBuild();
    const keyInput = h('input', { class: 'set-input', placeholder: 'Paste your license key', 'aria-label': 'License key', spellcheck: 'false' });
    const perks = ['Unlimited saved tabs', 'Research projects', 'Weekly Read later reminder', 'Fading for unread tabs', 'Export to JSON and Markdown'];
    return card('lifetime', 'Nook Lifetime', [
      has
        ? h('p', { class: 'set-note top' }, lic.source === 'dev' ? 'Unlocked for development on this computer.' : 'You have Nook Lifetime. Everything is unlocked.')
        : h('p', { class: 'set-note top' }, `The free version holds ${FREE_LIMIT} tabs. Lifetime is a one-time purchase that adds:`),
      !has && h('ul', { class: 'perks' }, perks.map((p) => h('li', null, icon('check', 14), p))),
      !has && (PAYMENTS.enabled
        ? h('div', { class: 'inline' },
            h('a', { class: 'btn primary small', href: PAYMENTS.checkoutUrl, target: '_blank', rel: 'noopener' }, `Get Lifetime, ${PAYMENTS.priceLabel}`))
        : h('p', { class: 'set-hint' }, 'Lifetime purchases open soon.')),
      !has && PAYMENTS.enabled && h('form', { class: 'inline license', onsubmit: async (e) => {
        e.preventDefault();
        try { await send('activateLicense', { key: keyInput.value }); toast('Nook Lifetime is active.'); } catch (err) { toast(err.message); }
      } }, keyInput, h('button', { class: 'btn small', type: 'submit' }, 'Activate')),
      dev && row('Developer unlock', 'Only in builds loaded from a folder. Turns Lifetime on for testing.',
        toggle(has && lic.source === 'dev', async (on) => { await send('devUnlock', { on }); }, 'Developer unlock', has && lic.source !== 'dev')),
    ]);
  }

  function shortcuts() {
    return card('shortcuts', 'Shortcuts', [
      row('Rest the tab you’re on', null, h('span', { class: 'keys' }, h('kbd', null, 'Alt'), h('kbd', null, 'Shift'), h('kbd', null, 'N'))),
      row('Change shortcuts', 'Chrome keeps extension shortcuts on its own page.',
        h('button', { class: 'btn small', onclick: () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }) }, 'Open shortcuts')),
    ]);
  }

  // ---- render

  function render() {
    if (!alive || !data) return;
    const y = scrollY;
    const active = document.activeElement;
    const focusKey = active?.getAttribute?.('aria-label');
    clear(root).append(
      h('header', { class: 'set-top' },
        h('a', { class: 'btn quiet small', href: '#' }, icon('back', 16), 'Back to Nook'),
        h('a', { class: 'brand', href: '#' }, brandMark(24), h('span', null, 'Nook'))),
      h('main', { class: 'settings' },
        h('h1', { class: 'set-heading' }, 'Settings'),
        timing(), sites(), reminders(), appearance(), dataCard(), MONETIZED && lifetimeCard(), shortcuts(),
        h('p', { class: 'set-foot' }, `Nook ${chrome.runtime.getManifest().version}. Nothing you save leaves this computer. `, h('a', { href: 'privacy.html', target: '_blank' }, 'Privacy policy'))),
    );
    scrollTo(0, y);
    if (focusKey) root.querySelector(`[aria-label="${CSS.escape(focusKey)}"]`)?.focus();
  }

  async function load(first = false) {
    data = await getAll();
    if (!alive) return;
    render();
    if (first && anchor) requestAnimationFrame(() => document.getElementById(`set-${anchor}`)?.scrollIntoView({ block: 'start' }));
  }

  // Re-render when the license or data change elsewhere; ignore our own settings saves
  // so typing in a box is never interrupted.
  const onStorage = (changes, area) => {
    if (area !== 'local' || !alive) return;
    if (changes.license || changes.records || changes.windows) {
      if (document.activeElement?.matches?.('textarea, input[type="number"], input[type="text"], .set-input')) return;
      load();
    }
  };
  chrome.storage.onChanged.addListener(onStorage);

  load(true);

  return () => {
    alive = false;
    chrome.storage.onChanged.removeListener(onStorage);
  };
}
