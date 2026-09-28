// Home screen: the counter, the cooldown, the live leaderboard and the activity feed.

import {
  api, getSession, clearSession, connectStream, doorGlyph, tallyGroup,
  fmtClock, fmtCountdown, fmtAgo, pad2, initTheme, toast, copyText, reduceMotion,
} from './common.js';

const $ = (id) => document.getElementById(id);
const session = getSession();

if (!session) {
  location.replace('/welcome.html');
} else {
  start();
}

function start() {
  const state = {
    me: null,          // my numbers, from /api/me and /api/tick
    snap: null,        // the latest public snapshot pushed by the server
    offset: 0,         // server clock minus this device's clock
    tab: 'today',
    day: null,
    busy: false,
    live: 'connecting',
    mode: null,        // 'ready' or 'cooling', so the button is only rebuilt when it changes
    feedReady: false,
    rollAt: 0,
    pinned: null,
  };
  const serverNow = () => Date.now() + state.offset;
  const cooldownMs = () => (state.me && state.me.cooldownMs) || (state.snap && state.snap.cooldownMs) || 60000;

  initTheme($('theme'));
  $('acct-name').textContent = session.nickname;
  $('acct-glyph').append(doorGlyph(session.nickname));
  $('nick').textContent = session.nickname;

  /* ---------- small helpers ---------- */

  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };

  function setWithUnit(el, value, unit) {
    el.replaceChildren(String(value));
    if (unit) {
      const small = document.createElement('small');
      small.textContent = unit;
      el.append(small);
    }
  }

  function replay(el, cls) {
    if (reduceMotion()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    const done = (e) => {
      if (e.target !== el) return; // ignore animations on children
      el.classList.remove(cls);
      el.removeEventListener('animationend', done);
    };
    el.addEventListener('animationend', done);
  }

  function signOut() {
    clearSession();
    location.replace('/welcome.html');
  }

  /* ---------- my door ---------- */

  function setMe(me) {
    const prev = state.me;
    state.me = me;

    const numeral = $('numeral');
    if (numeral.textContent !== String(me.today)) {
      numeral.textContent = me.today;
      if (prev && me.today > prev.today) replay(numeral, 'pop');
    }
    renderTally(prev ? prev.today : me.today, me.today);
    setText($('st-total'), me.total.toLocaleString());
    setText($('st-best'), me.bestDay.toLocaleString());
    setWithUnit($('st-streak'), me.streak, me.streak === 1 ? 'day' : 'days');
    renderRank();
    renderBoard();
    frame();
  }

  function renderTally(prev, count) {
    const host = $('tally');
    if (host.dataset.count === String(count)) return;
    host.dataset.count = String(count);
    host.replaceChildren();
    if (count === 0) {
      const idle = document.createElement('span');
      idle.className = 'tally-idle';
      idle.textContent = 'Your first mark goes here.';
      host.append(idle);
      return;
    }
    const shown = Math.min(count, 60);
    const groups = Math.ceil(shown / 5);
    const fresh = count === prev + 1 && count <= 60 ? (count - 1) % 5 : -1;
    for (let g = 0; g < groups; g++) {
      host.append(tallyGroup(Math.min(5, shown - g * 5), g === groups - 1 ? fresh : -1));
    }
    if (count > 60) {
      const more = document.createElement('span');
      more.className = 'tally-more mono-label';
      more.textContent = `+${count - 60} more`;
      host.append(more);
    }
  }

  function renderRank() {
    const el = $('st-rank');
    const mine = state.snap && state.snap.today.find((r) => r.id === session.id);
    if (mine) setWithUnit(el, `#${mine.rank}`, `of ${state.snap.totals.players}`);
    else if (state.me && state.me.today > 0) setWithUnit(el, '#100+', '');
    else setWithUnit(el, '–', '');
  }

  function cooldownRemaining() {
    return state.me ? Math.max(0, state.me.lastTickAt + cooldownMs() - serverNow()) : 0;
  }

  async function onTick() {
    if (state.busy || !state.me) return;
    const remaining = cooldownRemaining();
    if (remaining > 0) {
      toast(`Next door in ${fmtClock(remaining)}. The wait keeps the board fair.`);
      return;
    }
    state.busy = true;
    $('tick').classList.add('busy');
    try {
      const { me } = await api('/api/tick', { method: 'POST', auth: true });
      state.offset = me.serverTime - Date.now();
      setMe(me);
      replay($('door'), 'swing');
      toast(me.today === 1 ? 'First door of the day counted.' : `Door counted. That is ${me.today} today.`);
    } catch (err) {
      if (err.status === 401) return signOut();
      if (err.status === 429 && err.data && err.data.lastTickAt !== undefined) {
        state.offset = err.data.serverTime - Date.now();
        state.me.lastTickAt = err.data.lastTickAt;
        frame();
        toast(`Next door in ${fmtClock(err.data.retryAfterMs)}. The wait keeps the board fair.`);
      } else {
        toast(err.message, 'error');
      }
    } finally {
      state.busy = false;
      $('tick').classList.remove('busy');
    }
  }

  async function refreshMe() {
    try {
      const { me } = await api('/api/me', { auth: true });
      state.offset = me.serverTime - Date.now();
      setMe(me);
    } catch (err) {
      if (err.status === 401) signOut();
    }
  }

  /* ---------- the once-a-quarter-second frame: cooldown ring, countdowns, ages ---------- */

  function frame() {
    const now = serverNow();
    const remaining = cooldownRemaining();
    const cooling = remaining > 0;
    const btn = $('tick');

    $('ring').style.strokeDashoffset = String(cooling ? remaining / cooldownMs() : 0);
    btn.setAttribute('aria-disabled', String(cooling));

    const mode = cooling ? 'cooling' : 'ready';
    if (state.mode !== mode) {
      state.mode = mode;
      if (cooling) {
        $('push-main').replaceChildren('');
        setText($('push-sub'), 'Until next door');
      } else {
        $('push-main').replaceChildren('I held', document.createElement('br'), 'a door');
        setText($('push-sub'), 'Tap to count it');
      }
    }
    if (cooling) setText($('push-main'), fmtClock(remaining));

    if (state.snap) {
      const left = state.snap.dayEndsAt - now;
      if (left > 0) {
        setText($('reset'), `Board resets in ${fmtCountdown(left)}`);
      } else if (now - state.rollAt > 5000) {
        state.rollAt = now; // midnight passed: fetch the new day
        api('/api/state').then(applySnapshot).catch(() => {});
      }
    }

    document.querySelectorAll('#feed time').forEach((t) => {
      setText(t, fmtAgo(now - Number(t.dataset.at)));
    });
  }

  /* ---------- live snapshot ---------- */

  function applySnapshot(snap) {
    state.offset = snap.serverTime - Date.now();
    state.snap = snap;

    if (state.day && state.day !== snap.day) refreshMe();
    state.day = snap.day;

    // I tapped on another device: pull in my new numbers and cooldown.
    const mine = snap.activity.find((a) => a.userId === session.id);
    if (state.me && mine && mine.at > state.me.lastTickAt) refreshMe();

    renderLive();
    renderRank();
    renderBoard();
    renderFeed();
    frame();
  }

  function renderLive() {
    const live = $('live');
    live.dataset.status = state.live;
    if (state.live === 'reconnecting') {
      setText($('live-text'), 'Reconnecting');
      setText($('live-online'), '');
    } else {
      setText($('live-text'), state.live === 'live' ? 'Live' : 'Connecting');
      const n = state.snap ? state.snap.online : 0;
      setText($('live-online'), n > 0 ? ` · ${n} here now` : '');
    }
  }

  /* ---------- leaderboard ---------- */

  function buildRow(nickname) {
    const li = document.createElement('li');
    li.className = 'row';
    const rank = document.createElement('span');
    rank.className = 'row-rank';
    const glyph = document.createElement('span');
    glyph.append(doorGlyph(nickname));
    const name = document.createElement('span');
    name.className = 'row-name';
    const nickLine = document.createElement('span');
    nickLine.className = 'row-nick';
    const nick = document.createElement('span');
    const tag = document.createElement('span');
    tag.className = 'tag-you';
    tag.textContent = 'You';
    nickLine.append(nick, tag);
    const sub = document.createElement('span');
    sub.className = 'row-sub';
    const meter = document.createElement('span');
    meter.className = 'meter';
    const fill = document.createElement('i');
    meter.append(fill);
    name.append(nickLine, sub, meter);
    const count = document.createElement('span');
    count.className = 'row-count';
    li.append(rank, glyph, name, count);
    li._r = { rank, nick, tag, sub, fill, count };
    return li;
  }

  function updateRow(li, row, max) {
    const r = li._r;
    li.dataset.id = row.id;
    li.classList.toggle('me', row.id === session.id);
    setText(r.rank, row.rank ? pad2(row.rank) : row.rankLabel || '–');
    r.rank.classList.toggle('top', !!row.rank && row.rank <= 3);
    setText(r.nick, row.nickname);
    r.tag.hidden = row.id !== session.id;
    setText(r.sub, state.tab === 'today'
      ? (row.streak >= 2 ? `${row.streak}-day streak` : '')
      : `${row.today} today`);
    r.fill.style.width = `${max > 0 ? Math.max(4, (row.count / max) * 100) : 0}%`;
    const before = li.dataset.count === undefined ? null : Number(li.dataset.count);
    setText(r.count, row.count.toLocaleString());
    li.dataset.count = String(row.count);
    if (before !== null && row.count > before) replay(li, 'bump');
  }

  function renderBoard() {
    if (!state.snap) return;
    const snap = state.snap;
    const today = state.tab === 'today';
    const rows = today ? snap.today : snap.allTime;
    const list = $('board');

    setText($('board-note'), today
      ? `Ranked by doors held today. Resets at midnight, ${snap.timezone}.`
      : 'Ranked by every door held.');

    const before = new Map();
    const existing = new Map();
    for (const el of list.children) {
      before.set(el.dataset.id, el.getBoundingClientRect().top);
      existing.set(el.dataset.id, el);
    }

    const max = rows.length ? rows[0].count : 1;
    const ordered = rows.map((row) => {
      let el = existing.get(row.id);
      if (!el) el = buildRow(row.nickname);
      existing.delete(row.id);
      updateRow(el, row, max);
      return el;
    });
    existing.forEach((el) => el.remove());
    ordered.forEach((el, i) => {
      if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
    });

    if (!reduceMotion()) {
      for (const el of ordered) {
        const old = before.get(el.dataset.id);
        if (old === undefined) continue;
        const dy = old - el.getBoundingClientRect().top;
        if (Math.abs(dy) > 1) {
          el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }],
            { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' });
        }
      }
    }

    setText($('board-empty-title'), today
      ? 'Nobody has counted a door yet today.'
      : 'Nobody has counted a door yet.');
    $('board-empty').hidden = rows.length > 0;

    // My own row stays visible even when I am not on the board yet.
    const me = state.me;
    const pinnedHost = $('board-me');
    const inList = rows.some((r) => r.id === session.id);
    const myCount = me ? (today ? me.today : me.total) : 0;
    if (me && !inList && (rows.length > 0 || myCount > 0)) {
      if (!state.pinned) {
        state.pinned = buildRow(me.nickname);
        $('board-me-list').append(state.pinned);
      }
      updateRow(state.pinned, {
        id: me.id, nickname: me.nickname, rank: 0, rankLabel: myCount > 0 ? '100+' : '–',
        count: myCount, today: me.today, streak: me.streak,
      }, max || 1);
      pinnedHost.hidden = false;
    } else {
      pinnedHost.hidden = true;
    }
  }

  function setTab(tab, focus) {
    if (tab === state.tab) return;
    state.tab = tab;
    for (const [id, name] of [['tab-today', 'today'], ['tab-all', 'all']]) {
      const b = $(id);
      b.setAttribute('aria-selected', String(name === tab));
      b.tabIndex = name === tab ? 0 : -1;
      if (focus && name === tab) b.focus();
    }
    $('board-panel').setAttribute('aria-labelledby', tab === 'today' ? 'tab-today' : 'tab-all');
    $('board').replaceChildren();
    if (state.pinned) { state.pinned.remove(); state.pinned = null; }
    renderBoard();
  }

  /* ---------- live feed ---------- */

  function renderFeed() {
    const list = $('feed');
    const items = state.snap.activity;
    const existing = new Map([...list.children].map((li) => [li.dataset.id, li]));

    const ordered = items.map((a) => {
      let li = existing.get(a.id);
      if (!li) {
        li = document.createElement('li');
        li.dataset.id = a.id;
        if (state.feedReady) li.classList.add('enter');
        const glyph = document.createElement('span');
        glyph.append(doorGlyph(a.nickname));
        const who = document.createElement('span');
        who.className = 'who';
        const b = document.createElement('b');
        b.textContent = a.userId === session.id ? 'You' : a.nickname;
        who.append(b, ' held a door');
        const time = document.createElement('time');
        time.dataset.at = String(a.at);
        li.append(glyph, who, time);
      }
      existing.delete(a.id);
      return li;
    });
    existing.forEach((li) => li.remove());
    ordered.forEach((li, i) => {
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    });
    $('feed-empty').hidden = items.length > 0;
    state.feedReady = true;
  }

  /* ---------- account dialog ---------- */

  const dlg = $('acct');
  function resetSignOutUi() {
    $('acct-out').hidden = false;
    $('acct-out-yes').hidden = true;
    $('acct-out-no').hidden = true;
  }
  $('acct-btn').addEventListener('click', () => {
    setText($('acct-sub'), `Signed in as ${session.nickname}.`);
    setText($('acct-key'), session.code);
    resetSignOutUi();
    if (typeof dlg.showModal === 'function') dlg.showModal();
  });
  $('acct-close').addEventListener('click', () => dlg.close());
  $('acct-copy').addEventListener('click', async (e) => {
    const ok = await copyText(session.code, $('acct-key'));
    const btn = e.currentTarget;
    btn.textContent = ok ? 'Copied' : 'Press Ctrl+C to copy';
    setTimeout(() => { btn.textContent = 'Copy key'; }, 2200);
  });
  $('acct-out').addEventListener('click', () => {
    $('acct-out').hidden = true;
    $('acct-out-yes').hidden = false;
    $('acct-out-no').hidden = false;
    $('acct-out-no').focus();
  });
  $('acct-out-no').addEventListener('click', resetSignOutUi);
  $('acct-out-yes').addEventListener('click', signOut);

  /* ---------- wiring ---------- */

  $('tick').addEventListener('click', onTick);

  const tabs = [$('tab-today'), $('tab-all')];
  tabs[0].addEventListener('click', () => setTab('today'));
  tabs[1].addEventListener('click', () => setTab('all'));
  for (const [i, tab] of tabs.entries()) {
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setTab(i === 0 ? 'all' : 'today', true);
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshMe();
      api('/api/state').then(applySnapshot).catch(() => {});
    }
  });

  connectStream(applySnapshot, (status) => { state.live = status; renderLive(); });
  refreshMe();
  setInterval(frame, 250);
  frame();
}
