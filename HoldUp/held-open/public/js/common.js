// Shared helpers for the funnel page and the home screen.

const SESSION_KEY = 'heldopen.session';
const THEME_KEY = 'heldopen.theme';
const SVG_NS = 'http://www.w3.org/2000/svg';

export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- session (this device's saved login) ---------- */

export function getSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return s && s.id && s.code ? s : null;
  } catch { return null; }
}

export function saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ }
}

/* ---------- server calls ---------- */

export async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const s = getSession();
    if (s) headers.Authorization = `Bearer ${s.id}:${s.code}`;
  }
  let res;
  try {
    res = await fetch(path, {
      method, headers, cache: 'no-store',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('Could not reach the server. Check your connection and try again.');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || 'Something went wrong. Try again.');
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

/* Live updates. Calls onState with every snapshot the server pushes. */
export function connectStream(onState, onStatus = () => {}) {
  let source = null;
  let retry = null;
  let closed = false;

  function open() {
    clearTimeout(retry);
    source = new EventSource('/api/stream');
    source.addEventListener('state', (e) => {
      try { onState(JSON.parse(e.data)); } catch { /* ignore a bad frame */ }
    });
    source.onopen = () => onStatus('live');
    source.onerror = () => {
      onStatus('reconnecting');
      if (source.readyState === EventSource.CLOSED && !closed) retry = setTimeout(open, 3000);
    };
  }
  open();

  // Phones freeze background tabs; make sure the stream is alive when the tab returns.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && source.readyState !== EventSource.OPEN && !closed) {
      source.close();
      open();
    }
  });
  return { close() { closed = true; clearTimeout(retry); source.close(); } };
}

/* ---------- small formatting helpers ---------- */

export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function fmtCountdown(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  return `${total}s`;
}

export function fmtAgo(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const pad2 = (n) => String(n).padStart(2, '0');

export function formatCode(text) {
  const raw = String(text).toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 16);
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

/* ---------- door glyphs: every nickname gets its own front door colour ---------- */

const DOOR_COLORS = ['#B23A2E', '#2C6E9B', '#2F8060', '#C58A16', '#6D4C93', '#CC5F2A', '#1F8A90', '#55606E'];

function hash(str) {
  let h = 2166136261;
  for (const ch of str.toLowerCase()) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  children.forEach((c) => node.appendChild(c));
  return node;
}

export function doorGlyph(name) {
  const color = DOOR_COLORS[hash(name) % DOOR_COLORS.length];
  return svg('svg', { viewBox: '0 0 24 30', class: 'glyph', 'aria-hidden': 'true', focusable: 'false' }, [
    svg('path', { d: 'M2 29V11a10 10 0 0 1 20 0v18z', fill: color }),
    svg('path', { d: 'M6.5 27V12.5a5.5 5.5 0 0 1 11 0V27z', fill: 'none', stroke: '#fff', 'stroke-opacity': '.28', 'stroke-width': '1.2' }),
    svg('circle', { cx: '17', cy: '19.5', r: '1.5', fill: '#F3D48A' }),
  ]);
}

/* ---------- tally marks: four strokes and a slash, in groups of five ---------- */

export function tallyGroup(n, freshIndex = -1) {
  const strokes = [6, 15, 24, 33].slice(0, Math.min(n, 4)).map((x, i) =>
    svg('line', { x1: x, y1: 4, x2: x, y2: 30, pathLength: 1, class: i === freshIndex ? 'stroke fresh' : 'stroke' }));
  if (n >= 5) {
    strokes.push(svg('line', { x1: 1, y1: 26, x2: 38, y2: 8, pathLength: 1, class: freshIndex === 4 ? 'stroke fresh' : 'stroke' }));
  }
  return svg('svg', { viewBox: '0 0 40 34', class: 'tally-group', 'aria-hidden': 'true' }, strokes);
}

/* ---------- theme ---------- */

export function initTheme(button) {
  const root = document.documentElement;
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  const effective = () => root.getAttribute('data-theme') || (dark.matches ? 'dark' : 'light');

  const sync = () => {
    if (!button) return;
    const isDark = effective() === 'dark';
    button.setAttribute('aria-pressed', String(isDark));
    button.setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
  };
  sync();
  dark.addEventListener('change', sync);
  if (!button) return;
  button.addEventListener('click', () => {
    const next = effective() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* storage blocked */ }
    sync();
  });
}

/* ---------- toasts ---------- */

export function toast(message, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  host.appendChild(node);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 250);
  }, 3200);
}

/* ---------- clipboard with a select-and-copy fallback ---------- */

export async function copyText(text, fallbackEl) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackEl) {
      const range = document.createRange();
      range.selectNodeContents(fallbackEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return false;
  }
}
