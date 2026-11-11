// Candidate color schemes for Nook. Each has a light and a dark set of the tokens in base.css.
// Load a page with ?palette=<key> to try one; palettes.html shows them side by side.
window.NOOK_PALETTES = [
  {
    key: 'current', name: 'Dusk (current)', blurb: 'Today’s lavender greys and deep indigo, on white.',
    light: { bg: '#FFFFFF', paper: '#F7F6FA', paper2: '#DEDBE7', ink: '#25233A', ink2: '#67637E', ink3: '#8E8AA3', line: '#D2CFDC', accent: '#403C86', onAccent: '#F7F6FA', lamp: '#D99A3D' },
    dark: { bg: '#16151F', paper: '#201F2C', paper2: '#2A2939', ink: '#ECEAF4', ink2: '#B2AEC6', ink3: '#85819B', line: '#34324A', accent: '#ADA8F0', onAccent: '#16151F', lamp: '#E0A243' },
  },
  {
    key: 'ink', name: 'Ink & Paper', blurb: 'Pure neutrals and near-black navy. Matches your reference screenshot.',
    light: { bg: '#FFFFFF', paper: '#F9FAFB', paper2: '#F3F4F6', ink: '#111827', ink2: '#4B5563', ink3: '#9CA3AF', line: '#E5E7EB', accent: '#111827', onAccent: '#FFFFFF', lamp: '#D97706' },
    dark: { bg: '#0B0D12', paper: '#111827', paper2: '#1F2937', ink: '#F9FAFB', ink2: '#A3AAB8', ink3: '#6B7280', line: '#263041', accent: '#F9FAFB', onAccent: '#111827', lamp: '#F59E0B' },
  },
  {
    key: 'ocean', name: 'Ocean', blurb: 'Cool slate with a clear blue accent. Crisp and familiar.',
    light: { bg: '#F8FAFC', paper: '#FFFFFF', paper2: '#EEF2F7', ink: '#0F172A', ink2: '#475569', ink3: '#94A3B8', line: '#E2E8F0', accent: '#2563EB', onAccent: '#FFFFFF', lamp: '#F59E0B' },
    dark: { bg: '#0B1120', paper: '#111A2E', paper2: '#1A2540', ink: '#E2E8F0', ink2: '#94A3B8', ink3: '#64748B', line: '#24314D', accent: '#60A5FA', onAccent: '#0B1120', lamp: '#FBBF24' },
  },
  {
    key: 'sage', name: 'Sage', blurb: 'Soft green-greys with a forest accent. Calm, like a quiet room.',
    light: { bg: '#FBFBF8', paper: '#F4F5F0', paper2: '#E8EBE2', ink: '#1F2A22', ink2: '#56614F', ink3: '#8C957F', line: '#DDE2D3', accent: '#3F6B4F', onAccent: '#FFFFFF', lamp: '#C98A2B' },
    dark: { bg: '#121612', paper: '#1A201B', paper2: '#242C25', ink: '#E7EDE4', ink2: '#A9B5A3', ink3: '#76826F', line: '#2E382F', accent: '#8FC4A0', onAccent: '#121612', lamp: '#E5B162' },
  },
  {
    key: 'plum', name: 'Plum', blurb: 'Warm pinkish neutrals with a rich berry accent.',
    light: { bg: '#FFFFFF', paper: '#FBF7FB', paper2: '#F3EAF2', ink: '#2A1730', ink2: '#6B5470', ink3: '#A08AA4', line: '#EADDE9', accent: '#8E2C6E', onAccent: '#FFFFFF', lamp: '#D98A2B' },
    dark: { bg: '#150E17', paper: '#1E1521', paper2: '#2A1E2E', ink: '#F3E8F1', ink2: '#BFA8BC', ink3: '#85708A', line: '#36283A', accent: '#E08BC4', onAccent: '#150E17', lamp: '#E5B162' },
  },
  {
    key: 'ember', name: 'Ember', blurb: 'Stone neutrals with a bright orange accent. Energetic.',
    light: { bg: '#FFFFFF', paper: '#FAFAF9', paper2: '#F1F0EE', ink: '#1C1917', ink2: '#57534E', ink3: '#A8A29E', line: '#E7E5E4', accent: '#EA580C', onAccent: '#FFFFFF', lamp: '#D97706' },
    dark: { bg: '#0F0E0D', paper: '#1A1816', paper2: '#24211E', ink: '#F5F5F4', ink2: '#A8A29E', ink3: '#78716C', line: '#2E2A27', accent: '#FB923C', onAccent: '#0F0E0D', lamp: '#FBBF24' },
  },
];

(() => {
  const key = new URLSearchParams(location.search).get('palette');
  const p = key && window.NOOK_PALETTES.find((x) => x.key === key);
  if (!p) return;
  const vars = (s) => `--bg:${s.bg};--paper:${s.paper};--paper-2:${s.paper2};--ink:${s.ink};--ink-2:${s.ink2};--ink-3:${s.ink3};--line:${s.line};--accent:${s.accent};--on-accent:${s.onAccent};--focus:${s.accent};--lamp:${s.lamp};--c-window:${s.accent};`;
  const style = document.createElement('style');
  style.textContent = `:root{${vars(p.light)}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${vars(p.dark)}}}
:root[data-theme="dark"]{${vars(p.dark)}}`;
  document.head.append(style);
})();
