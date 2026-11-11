// "Why is this open?" One card at a time, one tap (or key) per tab.
import { INTENTS, LET_GO, TRIAGE_CHOICES, NOTE_MAX } from '../lib/constants.js';
import { getAll, send, isLifetime } from '../lib/store.js';
import { h, icon, clear, toast } from '../lib/ui.js';
import { timeAgo, plural, faviconFor } from '../lib/util.js';
import { thumbView } from '../lib/thumbview.js';
import { pickProject, editNote, stickyNote } from './picker.js';

const CHOICES = TRIAGE_CHOICES.map((id) => (id === 'close' ? LET_GO : INTENTS[id]));
const HINTS = {
  read_later: 'Get to it later',
  buying: 'Might buy it',
  todo: 'Needs doing',
  research: 'For a project',
  reference: 'Keep for good',
  close: 'Close it for good',
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function mountSort(root, { goHome }) {
  let data = null;
  let T = null;        // the sorting session
  let modal = null;
  let cardEl = null;
  let alive = true;

  function start() {
    const queue = Object.values(data.records)
      .filter((r) => r.intent === 'unsorted')
      .sort((a, b) => a.archivedAt - b.archivedAt)
      .map((r) => r.id);
    T = { queue, index: 0, undo: [], tally: {}, skipped: 0 };
  }

  function current() {
    while (T.index < T.queue.length) {
      const r = data.records[T.queue[T.index]];
      if (r && r.intent === 'unsorted') return r;
      T.index++;
    }
    return null;
  }

  async function load() {
    data = await getAll();
    if (!alive) return;
    if (!T) start();
    render();
  }

  // Tabs that come to rest while you're sorting join the end of the pile.
  const onStorage = async (changes, area) => {
    if (area !== 'local' || !changes.records) return;
    data = await getAll();
    if (!alive || !T) return;
    const known = new Set(T.queue);
    Object.values(data.records)
      .filter((r) => r.intent === 'unsorted' && !known.has(r.id))
      .sort((a, b) => a.archivedAt - b.archivedAt)
      .forEach((r) => T.queue.push(r.id));
    if (!modal) render();
  };
  chrome.storage.onChanged.addListener(onStorage);

  // ---- actions

  async function leave(kind) {
    if (!cardEl || reducedMotion()) return;
    cardEl.classList.add(kind === 'close' ? 'leaving-down' : 'leaving-up');
    await new Promise((r) => setTimeout(r, 170));
  }

  async function decide(id) {
    const r = current();
    if (!r || modal) return;
    let project = null;
    if (id === 'research' && isLifetime(data.license)) {
      modal = true;
      project = await pickProject(data.projects);
      modal = null;
      if (project === undefined) return;
    }
    T.undo.push({ index: T.index, before: { ...r }, choice: id });
    if (id === 'close') delete data.records[r.id];
    else data.records[r.id] = { ...r, intent: id, project };
    T.tally[id] = (T.tally[id] || 0) + 1;
    T.index++;
    await leave(id);
    render();
    send('assign', { ids: [r.id], intent: id, project }).catch((e) => toast(e.message));
  }

  function skip() {
    if (!current() || modal) return;
    T.undo.push({ index: T.index, choice: 'skip' });
    T.skipped++;
    T.index++;
    render();
  }

  async function openNow() {
    const r = current();
    if (!r || modal) return;
    T.undo.push({ index: T.index, before: { ...r }, choice: 'open' });
    delete data.records[r.id];
    T.tally.open = (T.tally.open || 0) + 1;
    T.index++;
    const win = await chrome.windows.getCurrent();
    send('restore', { ids: [r.id], remove: true, windowId: win.id, background: true }).catch((e) => toast(e.message));
    toast('Opened in a new tab.');
    render();
  }

  async function addNote() {
    const r = current();
    if (!r || modal) return;
    modal = true;
    const text = await editNote(r, NOTE_MAX);
    modal = null;
    if (text === undefined || text === (r.note || '')) return;
    data.records[r.id] = { ...r, note: text };
    render();
    send('setNote', { id: r.id, note: text }).catch((e) => toast(e.message));
  }

  function undo() {
    const e = T.undo.pop();
    if (!e || modal) return;
    if (e.before) {
      data.records[e.before.id] = e.before;
      send('putRecords', { records: [e.before] }).catch((err) => toast(err.message));
    }
    if (e.choice === 'skip') T.skipped--;
    else T.tally[e.choice]--;
    T.index = e.index;
    render();
  }

  // ---- keyboard

  const onKey = (e) => {
    if (modal || e.target.closest?.('input, textarea, select')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (mod || e.altKey) return;
    const choice = CHOICES.find((c) => c.key === e.key);
    if (choice) { e.preventDefault(); decide(choice.id); return; }
    const r = current();
    switch (e.key.toLowerCase()) {
      case 'enter': if (r && r.suggestedIntent) { e.preventDefault(); decide(r.suggestedIntent); } break;
      case 's': e.preventDefault(); skip(); break;
      case 'o': e.preventDefault(); openNow(); break;
      case 'n': e.preventDefault(); addNote(); break;
      case 'u': case 'backspace': e.preventDefault(); undo(); break;
      case 'escape': e.preventDefault(); goHome(); break;
      default:
    }
  };
  document.addEventListener('keydown', onKey);

  // ---- views

  function topBar() {
    const total = T.queue.length;
    const done = Math.min(T.index, total);
    return h('header', { class: 'sort-top' },
      h('button', { class: 'btn quiet small', onclick: goHome }, icon('back', 16), 'Back to Nook'),
      total > 0 && h('div', { class: 'progress', 'aria-label': `${done} of ${total} sorted` },
        h('span', { class: 'progress-text' }, done < total ? `${done + 1} of ${total}` : `${total} of ${total}`),
        h('span', { class: 'progress-bar' }, h('span', { style: { width: `${total ? (done / total) * 100 : 0}%` } }))),
    );
  }

  function when(r) {
    if (r.openedAt) return `Opened ${timeAgo(r.openedAt)}`;
    if (r.lastViewedAt) return `Last looked at ${timeAgo(r.lastViewedAt)}`;
    return `Resting since ${timeAgo(r.archivedAt)}`;
  }

  function cardView(r, left) {
    const thumb = thumbView(r, { className: 'card-thumb', faviconSize: 48 });
    if (r.note) thumb.append(stickyNote(r.note, addNote));
    cardEl = h('article', { class: 'card', 'aria-live': 'polite' },
      thumb,
      h('div', { class: 'card-body' },
        h('h1', { class: 'card-title', title: r.title }, r.title),
        h('div', { class: 'card-meta' },
          h('span', { class: 'card-site' }, h('img', { src: faviconFor(r.url, 16), width: 16, height: 16, alt: '' }), r.domain),
          h('span', null, when(r))),
        r.groupName && h('span', { class: 'card-group' }, `From the “${r.groupName}” tab group`),
      ),
    );
    return h('div', { class: 'deck', dataset: { left: String(Math.min(left, 2)) } }, cardEl);
  }

  function choiceButton(c, suggested) {
    return h('button', {
      class: 'choice' + (suggested ? ' suggested' : ''),
      'data-intent': c.id,
      'aria-keyshortcuts': c.key,
      onclick: () => decide(c.id),
    },
      h('kbd', null, c.key),
      h('span', { class: 'choice-label' }, c.label),
      h('span', { class: 'choice-hint' }, suggested ? 'Suggested' : HINTS[c.id]),
    );
  }

  function sortingView(r) {
    const left = T.queue.length - T.index - 1;
    return h('main', { class: 'sort-main' },
      cardView(r, left),
      h('h2', { class: 'ask' }, 'Why was this open?'),
      h('div', { class: 'choices', role: 'group', 'aria-label': 'Reasons' },
        CHOICES.map((c) => choiceButton(c, r.suggestedIntent === c.id))),
      h('div', { class: 'sort-secondary' },
        h('button', { class: 'btn quiet small', onclick: skip, 'aria-keyshortcuts': 's' }, 'Skip', h('kbd', null, 'S')),
        h('button', { class: 'btn quiet small', onclick: addNote, 'aria-keyshortcuts': 'n' }, r.note ? 'Edit note' : 'Add note', h('kbd', null, 'N')),
        h('button', { class: 'btn quiet small', onclick: openNow, 'aria-keyshortcuts': 'o' }, 'Open now', h('kbd', null, 'O')),
        h('button', { class: 'btn quiet small', onclick: undo, disabled: !T.undo.length, 'aria-keyshortcuts': 'u' }, icon('undo', 15), 'Undo', h('kbd', null, 'U')),
      ),
      r.suggestedIntent && h('p', { class: 'sort-tip' }, 'Press Enter to pick the suggestion.'),
    );
  }

  function doneView() {
    const parts = [...CHOICES.map((c) => [c.id, c.id === 'close' ? 'let go' : c.label]), ['open', 'opened']]
      .filter(([id]) => T.tally[id] > 0);
    const sortedAny = parts.length > 0;
    return h('main', { class: 'sort-main sort-done' },
      h('img', { src: '../icons/icon-128.png', width: 76, height: 76, alt: '', class: 'done-mark' }),
      h('h1', { class: 'done-title' }, sortedAny ? 'All sorted.' : T.skipped ? 'Done for now.' : 'Nothing to sort.'),
      h('p', { class: 'done-sub' }, 'Enjoy the quiet.'),
      sortedAny && h('div', { class: 'tally' },
        parts.map(([id, label]) => h('span', { class: 'tally-chip', 'data-intent': id === 'open' ? 'unsorted' : id },
          h('span', { class: 'dot' }), `${T.tally[id]} ${label}`))),
      T.skipped > 0 && h('p', { class: 'done-note' }, `${plural(T.skipped, 'tab')} skipped. ${T.skipped === 1 ? 'It stays' : 'They stay'} unsorted for next time.`),
      h('div', { class: 'done-actions' },
        h('button', { class: 'btn primary', onclick: goHome }, 'Back to Nook'),
        T.undo.length > 0 && h('button', { class: 'btn quiet', onclick: undo }, icon('undo', 15), 'Undo last'),
      ),
    );
  }

  function render() {
    if (!alive) return;
    const r = current();
    clear(root).append(h('div', { class: 'sort' }, topBar(), r ? sortingView(r) : doneView()));
  }

  load();

  return () => {
    alive = false;
    chrome.storage.onChanged.removeListener(onStorage);
    document.removeEventListener('keydown', onKey);
  };
}
