// Funnel page: pick a nickname, save the recovery key, then enter the home screen.
// Returning players can sign in from another device with their nickname and key.

import {
  api, getSession, saveSession, connectStream, doorGlyph, fmtAgo, formatCode, initTheme, copyText,
} from './common.js';

const $ = (id) => document.getElementById(id);
const ONBOARDING_FLAG = 'heldopen.onboarding';

initTheme($('theme'));

/* ---------- which step is showing ---------- */

const views = { nick: $('view-nick'), key: $('view-key'), signin: $('view-signin') };
const titles = { nick: 'nick-title', key: 'key-title', signin: 'signin-title' };

function show(name, focus = true) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  const step = { nick: 1, key: 2, signin: 0 }[name];
  $('step-label').textContent = name === 'signin' ? 'Sign in' : `Step ${step} of 2`;
  $('bar-1').parentElement.hidden = name === 'signin';
  $('bar-1').classList.toggle('on', step >= 1);
  $('bar-2').classList.toggle('on', step === 2);
  if (focus) $(titles[name]).focus();
}

function setStatus(el, state, message) {
  el.dataset.state = state;
  el.textContent = message;
}

/* ---------- step 1: nickname ---------- */

const nickInput = $('nick');
const nickStatus = $('nick-status');
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

// Mirrors the server's rules so people get feedback while typing. The server has the last word.
function checkLocally(raw) {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return { state: '', message: '' };
  if (name.length < 2) return { state: '', message: 'Keep going. Nicknames are at least 2 characters.' };
  if (name.length > 20) return { state: 'error', message: 'Nicknames are 20 characters or fewer.' };
  if (!LETTER_OR_NUMBER.test(name[0]) || !LETTER_OR_NUMBER.test(name[name.length - 1])) {
    return { state: 'error', message: 'Start and end with a letter or number.' };
  }
  if (/[^\p{L}\p{N} ._-]/u.test(name)) {
    return { state: 'error', message: 'Use letters, numbers, spaces, dots, dashes or underscores.' };
  }
  return { state: 'valid', name };
}

let checkTimer = 0;
let checkSeq = 0;

nickInput.addEventListener('input', () => {
  clearTimeout(checkTimer);
  nickInput.removeAttribute('aria-invalid');
  const result = checkLocally(nickInput.value);
  if (result.state !== 'valid') {
    setStatus(nickStatus, result.state, result.message);
    if (result.state === 'error') nickInput.setAttribute('aria-invalid', 'true');
    return;
  }
  setStatus(nickStatus, '', 'Checking…');
  const seq = ++checkSeq;
  checkTimer = setTimeout(async () => {
    try {
      await api(`/api/nickname?name=${encodeURIComponent(result.name)}`);
      if (seq === checkSeq) setStatus(nickStatus, 'ok', `${result.name} is available.`);
    } catch (err) {
      if (seq !== checkSeq) return;
      setStatus(nickStatus, 'error', err.message);
      nickInput.setAttribute('aria-invalid', 'true');
    }
  }, 350);
});

$('nick-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = checkLocally(nickInput.value);
  if (result.state !== 'valid') {
    setStatus(nickStatus, 'error', result.message || 'Enter a nickname to continue.');
    nickInput.setAttribute('aria-invalid', 'true');
    nickInput.focus();
    return;
  }
  const button = $('nick-go');
  button.disabled = true;
  button.textContent = 'Creating your door…';
  try {
    const { code, me } = await api('/api/register', { method: 'POST', body: { nickname: result.name } });
    saveSession({ id: me.id, nickname: me.nickname, code });
    try { sessionStorage.setItem(ONBOARDING_FLAG, '1'); } catch { /* ignore */ }
    showKey(me.nickname, code);
  } catch (err) {
    setStatus(nickStatus, 'error', err.message);
    nickInput.setAttribute('aria-invalid', 'true');
    nickInput.focus();
  } finally {
    button.disabled = false;
    button.textContent = 'Create my door';
  }
});

$('to-signin').addEventListener('click', () => show('signin'));

/* ---------- step 2: recovery key ---------- */

function showKey(nickname, code, focus = true) {
  $('key-nick').textContent = nickname;
  $('key-code').textContent = code;
  if (!getSession()) {
    // Browser is blocking storage (private window, for example).
    $('key-nick').parentElement.append(' Your browser is not saving sign-in data, so keep this key to get back in.');
  }
  show('key', focus);
}

$('key-copy').addEventListener('click', async (event) => {
  const ok = await copyText($('key-code').textContent, $('key-code'));
  const button = event.currentTarget;
  button.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
  setTimeout(() => { button.textContent = 'Copy key'; }, 2200);
});

$('key-enter').addEventListener('click', () => {
  try { sessionStorage.removeItem(ONBOARDING_FLAG); } catch { /* ignore */ }
  location.href = '/';
});

/* ---------- sign in on another device ---------- */

const codeInput = $('si-code');
const signinStatus = $('si-status');

codeInput.addEventListener('input', () => { codeInput.value = formatCode(codeInput.value); });

$('signin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const nickname = $('si-nick').value.trim();
  if (!nickname || codeInput.value.replace(/-/g, '').length < 16) {
    setStatus(signinStatus, 'error', 'Enter your nickname and the full 16 character key.');
    return;
  }
  const button = $('si-go');
  button.disabled = true;
  button.textContent = 'Signing in…';
  try {
    const { code, me } = await api('/api/login', { method: 'POST', body: { nickname, code: codeInput.value } });
    saveSession({ id: me.id, nickname: me.nickname, code });
    location.href = '/';
  } catch (err) {
    setStatus(signinStatus, 'error', err.message);
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

$('to-create').addEventListener('click', () => show('nick'));

/* ---------- live proof on the side ---------- */

let offset = 0;
let latest = [];

function renderTicker() {
  const list = $('ticker');
  list.replaceChildren();
  for (const a of latest.slice(0, 3)) {
    const li = document.createElement('li');
    const glyph = document.createElement('span');
    glyph.append(doorGlyph(a.nickname));
    const who = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = a.nickname;
    who.append(b, ' held a door');
    const time = document.createElement('time');
    time.textContent = fmtAgo(Date.now() + offset - a.at);
    li.append(glyph, who, time);
    list.append(li);
  }
}

connectStream((snap) => {
  offset = snap.serverTime - Date.now();
  $('p-doors').textContent = snap.totals.today.toLocaleString();
  $('p-people').textContent = snap.totals.players.toLocaleString();
  $('p-online').textContent = snap.online.toLocaleString();
  latest = snap.activity;
  renderTicker();
});
setInterval(renderTicker, 5000);

/* ---------- start ---------- */

const existing = getSession();
let flagged = false;
try { flagged = sessionStorage.getItem(ONBOARDING_FLAG) === '1'; } catch { /* ignore */ }
if (existing && flagged) showKey(existing.nickname, existing.code, false); // reloaded on step 2
