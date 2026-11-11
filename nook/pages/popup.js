import { getAll, send, isLifetime } from '../lib/store.js';
import { FREE_LIMIT, IDLE_CHOICES } from '../lib/constants.js';
import { h, icon, brandMark, applyTheme, clear } from '../lib/ui.js';
import { plural, isArchivableUrl } from '../lib/util.js';

const root = document.getElementById('popup');
let state;
let tab;

function idleLabel(minutes) {
  const choice = IDLE_CHOICES.find((c) => c.minutes === minutes);
  if (choice) return choice.label;
  return minutes < 60 ? plural(minutes, 'minute') : plural(Math.round(minutes / 60), 'hour');
}

function canRest(t) {
  return t && isArchivableUrl(t.url) && !t.url.startsWith(chrome.runtime.getURL(''));
}

async function openNook(hash = '') {
  await send('openNook', { hash });
  window.close();
}

async function rest(scope, name = '') {
  root.querySelectorAll('.p-action, .p-name-form button, .p-name-form input').forEach((b) => { b.disabled = true; });
  const msg = document.getElementById('msg');
  try {
    const { archived = 0, blocked = 0 } = await send('archive', { scope, tabId: tab?.id, windowId: tab?.windowId, name });
    let text = archived ? `Rested ${plural(archived, 'tab')}.` : 'No tabs to rest here.';
    if (blocked) text += ` Nook is full, so ${plural(blocked, 'tab')} stayed open.`;
    msg.textContent = text;
    setTimeout(() => window.close(), blocked ? 2600 : 1100);
  } catch (err) {
    msg.textContent = err.message;
    render();
  }
}

// Resting a whole window asks for an optional name first.
function askWindowName() {
  const group = root.querySelector('.p-actions');
  const input = h('input', { class: 'p-name-input', placeholder: 'e.g. Netflix deck research', maxlength: 60, 'aria-label': 'Window name (optional)' });
  const form = h('form', { class: 'p-name-form', onsubmit: (e) => { e.preventDefault(); rest('window', input.value.trim()); } },
    h('label', { class: 'p-name-label' }, 'Name this window', h('span', null, 'Optional')),
    input,
    h('div', { class: 'p-name-actions' },
      h('button', { class: 'btn quiet small', type: 'button', onclick: () => render() }, 'Cancel'),
      h('button', { class: 'btn primary small', type: 'submit' }, 'Rest window')),
  );
  group.replaceWith(form);
  input.focus();
}

function action(scope, label, hint, iconName, disabled = false) {
  return h('button', { class: 'p-action', disabled, onclick: () => (scope === 'window' ? askWindowName() : rest(scope)) },
    icon(iconName, 18),
    h('span', { class: 'p-action-label' }, label),
    h('span', { class: 'p-action-hint' }, hint),
  );
}

function render() {
  const list = Object.values(state.records);
  const total = list.length;
  const unsorted = list.filter((r) => r.intent === 'unsorted').length;
  const lifetime = isLifetime(state.license);
  const full = !lifetime && total >= FREE_LIMIT;
  const nearlyFull = !lifetime && !full && total >= FREE_LIMIT - 5;

  clear(root).append(...[
    h('header', { class: 'p-head' },
      brandMark(22),
      h('span', { class: 'p-name' }, 'Nook'),
      h('button', { class: 'iconbtn', 'aria-label': 'Settings', title: 'Settings', onclick: () => openNook('settings') }, icon('gear', 17)),
    ),

    h('section', { class: 'p-status' },
      h('p', { class: 'p-lead' }, total
        ? `${plural(total, 'tab')} ${total === 1 ? 'is' : 'are'} resting in Nook.`
        : 'Nothing is resting in Nook yet.'),
      h('p', { class: 'p-sub' }, total
        ? (unsorted ? `${unsorted} waiting to be sorted.` : 'Everything is sorted.')
        : `Tabs you haven’t looked at for ${idleLabel(state.settings.idleMinutes)} will rest here.`),
    ),

    unsorted
      ? h('button', { class: 'btn primary p-main', onclick: () => openNook('sort') }, 'Sort tabs', h('span', { class: 'count' }, String(unsorted)))
      : h('button', { class: 'btn primary p-main', onclick: () => openNook() }, 'Open Nook'),

    h('div', { class: 'p-actions', role: 'group', 'aria-label': 'Rest tabs now' },
      action('tab', 'Rest this tab', 'Closes it and keeps it in Nook', 'tab', !canRest(tab)),
      action('others', 'Rest other tabs', 'Keeps this tab and pinned tabs open', 'layers'),
      action('window', 'Rest this window', 'Saves its tabs together to reopen in one click', 'window'),
    ),

    h('p', { class: 'p-msg', id: 'msg', role: 'status' }),

    full && h('p', { class: 'p-note' },
      `Nook is full. The free version holds ${FREE_LIMIT} tabs, so idle tabs stay open for now. Nothing has been deleted.`),
    nearlyFull && h('p', { class: 'p-note' }, `Nook is holding ${total} of ${FREE_LIMIT} tabs on the free version.`),

    unsorted
      ? h('div', { class: 'p-foot' },
          h('span', null, `Rests tabs after ${idleLabel(state.settings.idleMinutes)}`),
          h('button', { class: 'p-link', onclick: () => openNook() }, 'Open Nook'))
      : h('div', { class: 'p-foot' },
          h('span', null, `Rests tabs after ${idleLabel(state.settings.idleMinutes)}`),
          h('button', { class: 'p-link', onclick: () => openNook('settings') }, 'Change')),
  ].filter(Boolean));
}

async function load() {
  state = await getAll();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  applyTheme(state.settings.theme);
  render();
  // Opened from the right-click menu's "Rest this window": go straight to naming it.
  const { askWindowName: pending } = await chrome.storage.session.get('askWindowName');
  if (pending) {
    await chrome.storage.session.remove('askWindowName');
    if (pending === tab?.windowId) askWindowName();
  }
}

load();
