// "Which project is this for?" Shared by sorting and the home page.
import { h, icon } from '../lib/ui.js';

let open = false;
export const pickerOpen = () => open;

// Resolves to a project name, null for "no project", or undefined if dismissed.
export function pickProject(projectsById = {}) {
  return new Promise((resolve) => {
    const projects = Object.values(projectsById)
      .filter((p) => !p.archived)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 8);
    const input = h('input', { class: 'picker-input', placeholder: 'New project name', 'aria-label': 'New project name', maxlength: 60 });
    let backdrop;
    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      open = false;
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); }
    };
    backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(undefined); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pick-title' },
        h('h2', { id: 'pick-title', class: 'modal-title' }, 'Which project is this for?'),
        projects.length > 0 && h('div', { class: 'picker-list' },
          projects.map((p) => h('button', { class: 'picker-item', type: 'button', onclick: () => close(p.name) }, icon('folder', 16), p.name))),
        h('form', { class: 'picker-new', onsubmit: (e) => { e.preventDefault(); close(input.value.trim() || null); } },
          input,
          h('button', { class: 'btn primary small', type: 'submit' }, 'Add project')),
        h('button', { class: 'btn quiet small picker-none', type: 'button', onclick: () => close(null) }, 'No project'),
      ),
    );
    open = true;
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    input.focus();
  });
}

// "Add a note": an optional 2-3 line description shown as a sticky note on the tab.
// Resolves to the new text ('' removes the note), or undefined if dismissed.
export function editNote(record, max = 200) {
  return new Promise((resolve) => {
    const area = h('textarea', {
      class: 'note-input',
      rows: 3,
      maxlength: max,
      placeholder: 'Why you kept it, what to do next…',
      'aria-label': 'Note',
    });
    area.value = record.note || '';
    const counter = h('span', { class: 'note-count' });
    const update = () => { counter.textContent = `${area.value.length}/${max}`; };
    area.addEventListener('input', update);
    update();
    let backdrop;
    const close = (value) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      open = false;
      resolve(value);
    };
    const save = () => close(area.value.trim());
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(undefined); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); save(); }
      else e.stopPropagation();
    };
    backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(undefined); } },
      h('form', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'note-title', onsubmit: (e) => { e.preventDefault(); save(); } },
        h('h2', { id: 'note-title', class: 'modal-title' }, record.note ? 'Edit note' : 'Add a note'),
        h('p', { class: 'note-for' }, record.title),
        area,
        h('div', { class: 'note-foot' },
          counter,
          h('div', { class: 'note-buttons' },
            record.note && h('button', { class: 'btn quiet small danger', type: 'button', onclick: () => close('') }, 'Remove note'),
            h('button', { class: 'btn quiet small', type: 'button', onclick: () => close(undefined) }, 'Cancel'),
            h('button', { class: 'btn primary small', type: 'submit' }, 'Save note'))),
      ),
    );
    open = true;
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
}

// The sticky note itself, placed over a thumbnail.
export function stickyNote(text, onEdit) {
  return h('button', { class: 'sticky', type: 'button', title: 'Edit note', onclick: (e) => { e.stopPropagation(); onEdit(); } }, text);
}
