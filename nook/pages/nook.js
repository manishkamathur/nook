// Nook page: a small router between the home view, sorting and settings.
import { getSettings } from '../lib/store.js';
import { applyTheme } from '../lib/ui.js';
import { mountSort } from './sort.js';
import { mountHome } from './home.js';
import { mountSettings } from './settings.js';

const app = document.getElementById('app');
let unmount = null;

const goHome = () => { location.hash = ''; };

async function route() {
  const s = await getSettings();
  applyTheme(s.theme);
  unmount?.();
  unmount = null;
  const [view, sub = ''] = location.hash.slice(1).split('/');
  if (view === 'sort') {
    document.body.dataset.route = 'sort';
    document.title = 'Sort tabs – Nook';
    unmount = mountSort(app, { goHome });
  } else if (view === 'settings') {
    document.body.dataset.route = 'settings';
    document.title = 'Settings – Nook';
    unmount = mountSettings(app, { anchor: sub });
  } else {
    document.body.dataset.route = 'home';
    document.title = 'Nook';
    unmount = mountHome(app, { anchor: view });
  }
}

addEventListener('hashchange', route);
route();
