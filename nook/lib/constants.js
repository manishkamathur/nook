// Shared definitions for the background worker and the pages.

export const INTENTS = {
  unsorted:   { id: 'unsorted',   label: 'Unsorted',   hint: 'Waiting for a reason',  groupColor: 'grey' },
  window:     { id: 'window',     label: 'Windows',    hint: 'Saved together',        groupColor: 'blue' },
  read_later: { id: 'read_later', label: 'Read later', hint: 'Something to get to',   groupColor: 'green',  key: '1' },
  buying:     { id: 'buying',     label: 'Buying',     hint: 'Thinking of getting it', groupColor: 'pink',   key: '2' },
  todo:       { id: 'todo',       label: 'To do',      hint: 'Needs doing',           groupColor: 'yellow', key: '3' },
  research:   { id: 'research',   label: 'Research',   hint: 'For a project',         groupColor: 'purple', key: '4' },
  reference:  { id: 'reference',  label: 'Reference',  hint: 'Keep for good',         groupColor: 'cyan',   key: '5' },
};

// The "no reason" choice is an action, not a place items live.
export const LET_GO = { id: 'close', label: 'No reason', hint: 'Close it for good', key: '6' };

export const TRIAGE_CHOICES = ['read_later', 'buying', 'todo', 'research', 'reference', 'close'];

// Order sections appear on the Nook page. To do comes first, per the brief.
export const SECTION_ORDER = ['todo', 'window', 'unsorted', 'read_later', 'buying', 'research', 'reference'];

// Optional note on a saved tab, shown as a sticky note on its thumbnail.
export const NOTE_MAX = 200;

// Phase 1 launches free: every feature is unlocked and there is no tab limit.
// Set to true when paid tiers are ready; the limit, Lifetime card and license code switch back on.
export const MONETIZED = false;

export const FREE_LIMIT = 50;

// Read later items fade after this long without being opened, then clear.
export const FADE_AFTER_DAYS = 30;
export const CLEAR_FADING_AFTER_DAYS = 7;

// Every site gets a thumbnail by default. People can add sites to skip in settings.
export const SENSITIVE_DEFAULTS = [];

// Any address containing one of these words is treated as sensitive too.
export const SENSITIVE_KEYWORDS = [];

export const NEVER_CLOSE_DEFAULTS = ['meet.google.com', 'zoom.us', 'teams.microsoft.com'];

export const DEFAULT_SETTINGS = {
  idleMinutes: 240,
  maxTabsEnabled: false,
  maxTabs: 20,
  neverCloseDomains: NEVER_CLOSE_DEFAULTS,
  noScreenshotDomains: SENSITIVE_DEFAULTS,
  digestEnabled: true,
  digestDay: 0,     // Sunday
  digestHour: 9,    // 9 am local
  expiryEnabled: false,   // fading is opt-in for everyone
  newTabOverride: false,
  viewMode: 'grid',
  theme: 'system',
  welcomeDismissed: false,
};

export const IDLE_CHOICES = [
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '1 day' },
];

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Payments. Fill these in once the Lemon Squeezy product exists; until then
// the Lifetime upgrade shows as "coming soon" (unpacked builds get a developer unlock).
export const PAYMENTS = {
  enabled: false,
  checkoutUrl: '',          // e.g. https://yourstore.lemonsqueezy.com/buy/xxxx
  storeId: null,            // number, from Lemon Squeezy
  productId: null,          // number, from Lemon Squeezy
  priceLabel: '$24 once',
};
