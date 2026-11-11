// Reading Nook's saved state. Only the background worker writes records;
// pages read from here and ask the worker to make changes.
import { DEFAULT_SETTINGS, MONETIZED } from './constants.js';

const local = chrome.storage.local;

export async function getRecords() {
  const { records } = await local.get('records');
  return records || {};
}

export async function getSettings() {
  const { settings } = await local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function getAll() {
  const data = await local.get(['records', 'projects', 'windows', 'settings', 'stats', 'license', 'meta']);
  return {
    records: data.records || {},
    projects: data.projects || {},
    windows: data.windows || {},
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    stats: data.stats || { tidied: {}, total: 0, restored: 0 },
    license: data.license || { plan: 'free' },
    meta: data.meta || {},
  };
}

export function isLifetime(license) {
  if (!MONETIZED) return true;
  return license && license.plan === 'lifetime';
}

export function isDevBuild() {
  // Store installs carry an update_url; unpacked (developer) installs don't.
  return !('update_url' in chrome.runtime.getManifest());
}

export function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((res) => {
    if (res && res.error) throw new Error(res.error);
    return res;
  });
}

export function onChange(fn) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') fn(changes);
  });
}
