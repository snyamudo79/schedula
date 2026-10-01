/* ==========================================================================
   Schedula — a time-blocked schedule + habit system that holds you to it.

   Rules the app enforces:
   1. Every block has a check-in window: [start - early, start + grace].
      Check in inside it or the block is automatically marked MISSED.
   2. Today's schedule is frozen the moment the day starts. Plan changes you
      commit take effect TOMORROW — you can't edit today to dodge a block.
   3. Habits can only be ticked for today. Past days are permanent.
   4. Every miss must be answered in the accountability check before you can
      keep using the app.
   All data lives in this browser's localStorage (export a backup in Settings).
   ========================================================================== */
(() => {
  'use strict';

  /* ---------- constants ---------- */
  const STORE_KEY = 'schedula.v1';
  const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const CATS = {
    focus: { label: 'Focus', color: '#7aa2ff' },
    health: { label: 'Health', color: '#34d399' },
    learning: { label: 'Learning', color: '#fbbf24' },
    life: { label: 'Life', color: '#f472b6' },
    rest: { label: 'Rest', color: '#a78bfa' },
  };
  // Quote library lives in quotes.js (window.SCHEDULA_QUOTES). Drop malformed entries and exact duplicates.
  const QUOTES = (() => {
    const seen = new Set(), out = [];
    for (const q of (Array.isArray(window.SCHEDULA_QUOTES) ? window.SCHEDULA_QUOTES : [])) {
      if (!Array.isArray(q) || typeof q[0] !== "string" || !q[0].trim() || typeof q[1] !== "string") continue;
      const k = q[0].trim().toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push([q[0].trim(), q[1].trim(), typeof q[2] === "string" ? q[2].trim() : ""]);
    }
    return out;
  })();
  /** Stable id from the quote text, so reordering or adding quotes never breaks the deck. */
  function quoteId(q) {
    let h = 5381;
    for (let i = 0; i < q[0].length; i++) h = ((h << 5) + h + q[0].charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  const UNDO_MS = 60 * 1000;
  const PRIO_EDIT_MS = 2 * 60 * 1000;
  const EXCUSE_MIN = 15;
  const GOOD_DAY = 0.8;
  const MAX_BACKFILL = 120;

  /* ---------- utils ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const pad = n => String(n).padStart(2, '0');
  const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parseKey(k); d.setDate(d.getDate() + n); return dkey(d); };
  const todayKey = () => dkey(new Date());
  const daysBetween = (a, b) => Math.round((parseKey(b) - parseKey(a)) / 86400000);
  const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
  const fmtMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60000; };
  const isHM = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const clone = o => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = v => (v === null || v === undefined) ? '—' : `${Math.round(v * 100)}%`;
  const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

  /** Epoch ms for wall-clock minute `min` (may be negative) of day `k`. */
  function epochAt(k, min) {
    const d = parseKey(k);
    d.setHours(Math.floor(min / 60), ((min % 60) + 60) % 60, 0, 0);
    return d.getTime();
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  }
  const fmtDateLong = k => { const d = parseKey(k); return `${DOW_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const fmtDateShort = k => { const d = parseKey(k); return `${DOW_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };

  const svg = p => `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
  const ICON = {
    today: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    habits: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="m14.5 17.5 2 2 4-4"/>'),
    plan: svg('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h3M8 17h6"/>'),
    stats: svg('<path d="M4 20V11M10 20V5M16 20v-6M21 20H3"/>'),
    settings: svg('<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    focus: svg('<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3"/>'),
    spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>'),
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    chevL: svg('<path d="m15 18-6-6 6-6"/>'),
    chevR: svg('<path d="m9 18 6-6-6-6"/>'),
    archive: svg('<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>'),
    download: svg('<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>'),
    upload: svg('<path d="M12 21V9M7 14l5-5 5 5M4 3h16"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    alert: svg('<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
    bell: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0"/>'),
  };

  /* ---------- state ---------- */
  const emptyWeek = () => { const w = {}; for (let i = 0; i < 7; i++) w[i] = []; return w; };
  const weekIsEmpty = w => [0, 1, 2, 3, 4, 5, 6].every(i => !w[i] || w[i].length === 0);
  const sortBlocks = list => list.sort((a, b) => toMin(a.start) - toMin(b.start));

  function defaultState() {
    const t = todayKey();
    const seed = [
      ['Wake up on time', '⏰'], ['Gym', '💪'], ['Reading / Learning', '📖'], ['Day planning', '🗓️'],
      ['Project work', '🎯'], ['No alcohol', '🚫'], ['Social media detox', '🌿'],
    ];
    return {
      version: 1,
      createdAt: t,
      lastEval: null,
      settings: { name: '', early: 5, grace: 10, sound: true, notify: false, pomoFocus: 25, pomoBreak: 5 },
      schedule: { active: emptyWeek(), pending: null },
      draft: null,
      habits: seed.map(([name, emoji]) => ({ id: uid(), name, emoji, created: t, archived: null })),
      habitLog: {},
      days: {},
      excuses: [],
      priorities: {}, // 'YYYY-MM-DD' -> [{ id, text, done, at }]
      inbox: [],      // [{ id, text, created, from? }]
      pomos: {},      // 'YYYY-MM-DD' -> completed focus sessions
      pomo: null,     // running timer: { phase, endsAt, dur } or { phase, paused: true, remaining, dur }
      reviews: {},    // 'YYYY-MM-DD' -> { rating, wins, lesson, at }
      quotes: { day: null, current: null, used: [], cycle: 1 }, // daily quote deck (ids from quoteId)
    };
  }

  function normWeek(w) {
    const o = emptyWeek();
    if (w && typeof w === 'object') {
      for (let i = 0; i < 7; i++) {
        o[i] = Array.isArray(w[i]) ? w[i].filter(b => b && isHM(b.start) && isHM(b.end) && toMin(b.end) > toMin(b.start)) : [];
        sortBlocks(o[i]);
      }
    }
    return o;
  }

  function migrate(s) {
    const d = defaultState();
    if (!s || typeof s !== 'object') return d;
    s.version = 1;
    s.createdAt = typeof s.createdAt === 'string' ? s.createdAt : d.createdAt;
    s.lastEval = typeof s.lastEval === 'string' ? s.lastEval : null;
    s.settings = Object.assign({}, d.settings, s.settings || {});
    s.schedule = s.schedule && typeof s.schedule === 'object' ? s.schedule : { active: emptyWeek(), pending: null };
    s.schedule.active = normWeek(s.schedule.active);
    if (s.schedule.pending && typeof s.schedule.pending.effective === 'string') s.schedule.pending.days = normWeek(s.schedule.pending.days);
    else s.schedule.pending = null;
    s.draft = s.draft ? normWeek(s.draft) : null;
    s.habits = Array.isArray(s.habits) ? s.habits : d.habits;
    s.habitLog = s.habitLog && typeof s.habitLog === 'object' ? s.habitLog : {};
    s.days = s.days && typeof s.days === 'object' ? s.days : {};
    s.excuses = Array.isArray(s.excuses) ? s.excuses : [];
    const obj = v => v && typeof v === 'object' && !Array.isArray(v);
    s.priorities = obj(s.priorities) ? s.priorities : {};
    s.inbox = Array.isArray(s.inbox) ? s.inbox : [];
    s.pomos = obj(s.pomos) ? s.pomos : {};
    s.pomo = obj(s.pomo) && (s.pomo.phase === 'focus' || s.pomo.phase === 'break') ? s.pomo : null;
    s.reviews = obj(s.reviews) ? s.reviews : {};
    const q = obj(s.quotes) ? s.quotes : {};
    s.quotes = {
      day: typeof q.day === 'string' ? q.day : null,
      current: typeof q.current === 'string' ? q.current : null,
      used: Array.isArray(q.used) ? q.used.filter(x => typeof x === 'string') : [],
      cycle: Number.isInteger(q.cycle) && q.cycle > 0 ? q.cycle : 1,
    };
    return s;
  }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { /* storage blocked */ }
    if (!raw) return defaultState();
    try {
      return migrate(JSON.parse(raw));
    } catch (e) {
      // Never silently destroy data: keep the unreadable copy aside.
      try { localStorage.setItem(`${STORE_KEY}.corrupt-${Date.now()}`, raw); } catch (_) { /* ignore */ }
      return defaultState();
    }
  }

  let saveFailed = false;
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      saveFailed = false;
    } catch (e) {
      if (!saveFailed) toast('Could not save — browser storage is unavailable or full. Export a backup.', 'bad');
      saveFailed = true;
    }
    if (window.SchedulaSync) window.SchedulaSync.localChanged(); // queue changed parts for upload (no-op when signed out)
  }

  let state = load();

  /* ---------- engine ---------- */
  function activeHabits(k) {
    return state.habits.filter(h => h.created <= k && (!h.archived || k < h.archived));
  }

  function applyPendingFor(k) {
    const p = state.schedule.pending;
    if (p && p.effective <= k) {
      state.schedule.active = p.days;
      state.schedule.pending = null;
      return true;
    }
    return false;
  }

  /** Freeze the schedule for day `k`. `partial` drops blocks whose window already closed. */
  function ensureDay(k, partial) {
    if (state.days[k]) return false;
    const { early, grace } = state.settings;
    const nm = nowMin();
    const src = state.schedule.active[parseKey(k).getDay()] || [];
    const blocks = src
      .filter(b => !partial || toMin(b.start) + grace >= nm)
      .map(b => ({ id: b.id, start: b.start, end: b.end, title: b.title, emoji: b.emoji, cat: b.cat, status: 'pending' }));
    state.days[k] = { blocks: sortBlocks(blocks), early, grace, snapAt: Date.now() }; // snapAt lets synced devices agree on the day's blocks
    return true;
  }

  /** Bring the whole system up to "now". Returns true if anything changed. */
  function evaluate() {
    const t = todayKey();
    let changed = false;

    if (state.lastEval && state.lastEval < t) {
      let k = addDays(state.lastEval, 1);
      if (daysBetween(k, t) > MAX_BACKFILL) k = addDays(t, -MAX_BACKFILL);
      while (k < t) {
        if (applyPendingFor(k)) changed = true;
        if (ensureDay(k, false)) changed = true;
        k = addDays(k, 1);
      }
    }
    if (applyPendingFor(t)) changed = true;
    if (ensureDay(t, !state.lastEval)) changed = true;

    const nm = nowMin();
    for (const k of Object.keys(state.days)) {
      const d = state.days[k];
      if (d.final) continue;
      if (k < t) {
        for (const b of d.blocks) if (b.status === 'pending') b.status = 'missed';
        // Unfinished priorities don't vanish — they roll into the inbox.
        for (const p of (state.priorities[k] || [])) {
          if (!p.done && !p.carried) { p.carried = true; state.inbox.unshift({ id: uid(), text: p.text, created: t, from: k }); }
        }
        d.final = true;
        changed = true;
      } else if (k === t) {
        for (const b of d.blocks) {
          if (b.status === 'pending' && nm > toMin(b.start) + d.grace) { b.status = 'missed'; changed = true; }
        }
      }
    }
    if (state.lastEval !== t) { state.lastEval = t; changed = true; }
    if (changed) save();
    return changed;
  }

  function dayStats(k) {
    const d = state.days[k];
    const blocks = d ? d.blocks : [];
    const hs = activeHabits(k);
    const log = state.habitLog[k] || {};
    const bDone = blocks.filter(b => b.status === 'done').length;
    const bMissed = blocks.filter(b => b.status === 'missed').length;
    const hDone = hs.filter(h => log[h.id]).length;
    const pr = state.priorities[k] || [];
    const pDone = pr.filter(p => p.done).length;
    const total = blocks.length + hs.length + pr.length;
    const valid = k >= state.createdAt && k <= todayKey();
    return {
      bDone, bMissed, bTotal: blocks.length, bPending: blocks.length - bDone - bMissed,
      hDone, hTotal: hs.length, pDone, pTotal: pr.length,
      score: valid && total ? (bDone + hDone + pDone) / total : null,
    };
  }

  function habitStreak(h) {
    const log = state.habitLog;
    let k = todayKey();
    if (!(log[k] && log[k][h.id])) k = addDays(k, -1);
    let n = 0;
    while (k >= h.created && log[k] && log[k][h.id]) { n++; k = addDays(k, -1); }
    return n;
  }

  function disciplineStreak() {
    const t = todayKey();
    let n = 0, k = addDays(t, -1);
    while (k >= state.createdAt) {
      const s = dayStats(k).score;
      if (s !== null) { if (s >= GOOD_DAY) n++; else break; }
      k = addDays(k, -1);
    }
    const ts = dayStats(t).score;
    if (ts !== null && ts >= GOOD_DAY) n++;
    return n;
  }

  function bestStreak() {
    const t = todayKey();
    let best = 0, run = 0, k = state.createdAt;
    while (k <= t) {
      const s = dayStats(k).score;
      if (s !== null) { if (s >= GOOD_DAY) { run++; best = Math.max(best, run); } else if (k < t) run = 0; }
      k = addDays(k, 1);
    }
    return best;
  }

  /** What deserves attention right now. */
  function currentFocus() {
    const t = todayKey();
    const d = state.days[t];
    if (!d || !d.blocks.length) return { mode: 'empty', block: null };
    const nm = nowMin();
    const open = d.blocks.find(b => b.status === 'pending' && nm >= toMin(b.start) - d.early && nm <= toMin(b.start) + d.grace);
    if (open) return { mode: 'open', block: open };
    const cur = d.blocks.find(b => b.status !== 'pending' && nm >= toMin(b.start) - (b.status === 'done' ? d.early : 0) && nm < toMin(b.end));
    if (cur) return { mode: cur.status === 'missed' ? 'missed-running' : (nm < toMin(cur.start) ? 'ready' : 'running'), block: cur };
    const next = d.blocks.find(b => b.status === 'pending' && toMin(b.start) - d.early > nm);
    if (next) return { mode: 'next', block: next };
    return { mode: 'finished', block: null };
  }
  const focusSig = () => { const f = currentFocus(); return `${todayKey()}|${f.mode}|${f.block ? f.block.id + f.block.status : ''}`; };

  function nextPendingAfter(block) {
    const d = state.days[todayKey()];
    if (!d) return null;
    return d.blocks.find(b => b.status === 'pending' && toMin(b.start) >= toMin(block.end)) || null;
  }

  /** Today's first finished block still waiting for a quality rating. */
  function blockNeedingReview() {
    const d = state.days[todayKey()];
    if (!d) return null;
    const nm = nowMin();
    return d.blocks.find(b => b.status === 'done' && !b.rating && nm >= toMin(b.end)) || null;
  }

  /** Advance the pomodoro timer. Returns true if its phase changed. */
  function pomoTick() {
    const p = state.pomo;
    if (!p || p.paused || Date.now() < p.endsAt) return false;
    if (p.phase === 'focus') {
      const k = dkey(new Date(p.endsAt));
      state.pomos[k] = (state.pomos[k] || 0) + 1;
      const dur = state.settings.pomoBreak * 60000;
      state.pomo = { phase: 'break', endsAt: p.endsAt + dur, dur };
      notify('Focus session complete 🍅', `Take a ${state.settings.pomoBreak}-minute break.`);
    } else {
      state.pomo = null;
      notify('Break over', 'Start your next focus session.');
    }
    save();
    return true;
  }

  function unackedMisses() {
    const out = [];
    for (const k of Object.keys(state.days).sort()) {
      for (const b of state.days[k].blocks) if (b.status === 'missed' && !b.acked) out.push({ k, b });
    }
    return out;
  }

  /* ---------- feedback: sound, notifications, toasts ---------- */
  let actx = null;
  function chime(kind) {
    if (!state.settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      const notes = kind === 'ok' ? [660, 880, 1320] : kind === 'alert' ? [880, 660, 880] : [440, 330];
      const t0 = actx.currentTime;
      notes.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        const at = t0 + i * 0.13;
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
        o.connect(g).connect(actx.destination);
        o.start(at); o.stop(at + 0.42);
      });
    } catch (e) { /* audio unavailable */ }
  }

  function notify(title, body) {
    chime('alert');
    if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, tag: title }); } catch (e) { /* ignore */ }
    }
  }

  const fired = new Set();
  function scanNotifications() {
    const t = todayKey(), d = state.days[t];
    if (!d) return;
    const nm = nowMin();
    for (const b of d.blocks) {
      if (b.status !== 'pending') continue;
      const s = toMin(b.start), close = s + d.grace;
      const kOpen = `${t}|${b.id}|open`, kWarn = `${t}|${b.id}|warn`;
      if (nm >= s - d.early && nm <= close && !fired.has(kOpen)) {
        fired.add(kOpen);
        notify(`Check in: ${b.emoji} ${b.title}`, `Window open until ${fmtMin(close)}. Miss it and it counts.`);
      }
      if (d.grace >= 4 && nm >= close - 2 && nm <= close && !fired.has(kWarn)) {
        fired.add(kWarn);
        notify(`2 minutes left — ${b.title}`, 'Check in now or this block is marked missed.');
      }
    }
  }

  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toastRoot').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3000);
    setTimeout(() => el.remove(), 3400);
  }

  /* ---------- modal ---------- */
  let modalKind = null, modalLocked = false, pendingConfirm = null;
  function openModal(html, { kind = 'generic', locked = false, cls = '' } = {}) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="overlay${locked ? ' locked' : ''}"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
    modalKind = kind; modalLocked = locked;
    document.body.classList.add('noscroll');
    const first = root.querySelector('textarea, input:not([type=hidden]):not([type=checkbox]), select, .btn.primary');
    if (first) first.focus();
  }
  function closeModal(force) {
    if (modalLocked && !force) return;
    $('#modalRoot').innerHTML = '';
    modalKind = null; modalLocked = false; pendingConfirm = null;
    document.body.classList.remove('noscroll');
  }
  function confirmModal({ title, body, ok = 'Confirm', danger = false, onOk }) {
    openModal(`
      <h2>${title}</h2>
      <p class="muted">${body}</p>
      <div class="modal-actions">
        <button class="btn ghost" data-action="close-modal">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-action="confirm-ok">${ok}</button>
      </div>`, { kind: 'confirm' });
    pendingConfirm = onOk;
  }

  /* ---------- UI state ---------- */
  const VIEWS = [
    { id: 'today', label: 'Today' },
    { id: 'habits', label: 'Habits' },
    { id: 'plan', label: 'Plan' },
    { id: 'stats', label: 'Stats' },
    { id: 'settings', label: 'Settings' },
  ];
  const viewFromHash = () => { const h = location.hash.replace('#', ''); return VIEWS.some(v => v.id === h) ? h : 'today'; };
  const now0 = new Date();
  const ui = {
    view: viewFromHash(),
    planDay: now0.getDay(),
    editId: null,
    month: { y: now0.getFullYear(), m: now0.getMonth() },
    sig: '',
    minute: -1,
    bonus: null,      // { day, idx } — an extra quote from ↻, doesn't consume the daily deck
    quoteAnim: false,
  };

  /**
   * Quote of the day. Draws from a deck: no quote repeats until every quote has
   * been shown, then a new shuffled cycle begins — so it never runs out.
   * Quotes added to quotes.js later join the current cycle automatically.
   */
  function dailyQuoteIndex() {
    if (!QUOTES.length) return -1;
    const t = todayKey(), qs = state.quotes;
    if (qs.day === t) {
      const i = QUOTES.findIndex(q => quoteId(q) === qs.current);
      if (i >= 0) return i;
    }
    const used = new Set(qs.used);
    let pool = QUOTES.map((_, i) => i).filter(i => !used.has(quoteId(QUOTES[i])));
    if (!pool.length) {
      qs.used = [];
      qs.cycle += 1;
      pool = QUOTES.map((_, i) => i).filter(i => quoteId(QUOTES[i]) !== qs.current); // no back-to-back repeat across cycles
      if (!pool.length) pool = [0];
    }
    const i = pool[Math.floor(Math.random() * pool.length)];
    qs.day = t;
    qs.current = quoteId(QUOTES[i]);
    qs.used.push(qs.current);
    save();
    return i;
  }

  function quoteHTML() {
    const daily = dailyQuoteIndex();
    if (daily < 0) return '';
    const t = todayKey();
    if (ui.bonus && ui.bonus.day !== t) ui.bonus = null;
    const idx = ui.bonus ? ui.bonus.idx : daily;
    const [text, author, source] = QUOTES[idx];
    const anim = ui.quoteAnim ? ' anim' : '';
    ui.quoteAnim = false; // animate only on a fresh pick, not on every minute re-render
    const seen = new Set(state.quotes.used.filter(id => QUOTES.some(q => quoteId(q) === id))).size;
    const label = ui.bonus
      ? `Bonus quote · <button class="link small qtoday" data-action="quote-today">back to today's</button>`
      : 'Quote of the day';
    return `<figure class="quote${anim}" title="${seen} of ${QUOTES.length} quotes shown in cycle ${state.quotes.cycle}. No repeats until all have appeared, then a fresh shuffle.">
      <span class="qmark" aria-hidden="true">“</span>
      <p class="qlabel">${label}</p>
      <blockquote>${esc(text)}</blockquote>
      <figcaption><b>${esc(author)}</b>${source ? `<span> · ${esc(source)}</span>` : ''}</figcaption>
      <button class="btn icon ghost qnext" data-action="quote-next" aria-label="Show another quote" title="Another quote (Q)">${ICON.refresh}</button>
    </figure>`;
  }

  /* ---------- shared renderers ---------- */
  function ringHTML(score, color) {
    const r = 62, c = 2 * Math.PI * r;
    const v = score === null ? 0 : clamp(score, 0, 1);
    const col = color || (score === null ? 'var(--line-2)' : v >= GOOD_DAY ? 'var(--good)' : v >= 0.5 ? 'var(--accent)' : 'var(--warn)');
    return `<div class="ring">
      <svg viewBox="0 0 150 150"><circle class="track" cx="75" cy="75" r="${r}" fill="none" stroke-width="12"/>
      <circle class="val" cx="75" cy="75" r="${r}" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - v)).toFixed(2)}"/></svg>
      <div class="label"><b>${pct(score)}</b><span>Today</span></div></div>`;
  }

  function heroHTML(f) {
    const t = todayKey(), d = state.days[t];
    if (f.mode === 'empty') {
      const noSchedule = weekIsEmpty(state.schedule.active);
      if (noSchedule && state.schedule.pending) {
        return `<div class="hero-empty"><p class="eyebrow">${ICON.lock} Locked in</p>
          <h2>Your schedule starts ${fmtDateShort(state.schedule.pending.effective)}.</h2>
          <p class="muted">Today is free. Tick your habits — tomorrow, the clock is in charge.</p></div>`;
      }
      return `<div class="hero-empty">
        <p class="eyebrow">${noSchedule ? 'Welcome' : 'No blocks today'}</p>
        <h2>${noSchedule ? 'Design your ideal day. Then live it.' : 'A free day. Keep your habits.'}</h2>
        <p class="muted">${noSchedule
          ? 'Build a time-blocked schedule. Each block opens a short check-in window — miss it and it counts. No editing today to dodge it.'
          : 'Nothing is scheduled today. Your daily habits still count.'}</p>
        ${noSchedule ? `<button class="btn primary" data-action="wizard">${ICON.spark} Build my schedule</button>` : ''}
        ${noSchedule && SYNC().configured && !syncUser() ? `<p class="muted small">Already use Schedula on another device? <button class="link small" data-action="auth-open" data-mode="signin">Sign in to sync</button></p>` : ''}
      </div>`;
    }
    if (f.mode === 'finished') {
      const st = dayStats(t);
      return `<div class="hero-empty">
        <p class="eyebrow">${ICON.check} Day complete</p>
        <h2>${st.bMissed === 0 ? 'Flawless. Every block, on time.' : `${st.bDone} of ${st.bTotal} blocks on time.`}</h2>
        <p class="muted">${st.hDone < st.hTotal ? `${st.hTotal - st.hDone} habit${st.hTotal - st.hDone === 1 ? '' : 's'} still open today — close them out.` : 'All habits done. Rest well; tomorrow starts on schedule.'}</p>
      </div>`;
    }
    const b = f.block, cat = CATS[b.cat] || CATS.focus;
    const s = toMin(b.start), e = toMin(b.end);
    let label, cdLabel, cd, body = '';
    if (f.mode === 'open') {
      label = 'Check-in open'; cdLabel = 'Window closes in'; cd = epochAt(t, s + d.grace);
      body = `<div class="hero-actions">
        <button class="btn primary xl pulse" data-action="checkin" data-id="${b.id}">${ICON.check} Check in now</button>
        <p class="hero-note">Miss the window and this block is logged as missed — permanently.</p></div>`;
    } else if (f.mode === 'ready') {
      label = 'Checked in'; cdLabel = 'Starts in'; cd = epochAt(t, s);
      body = `<div class="hero-actions">${intentionHTML(b)}<p class="hero-note">Locked in at ${b.doneAt}. Get set up.</p></div>`;
    } else if (f.mode === 'running') {
      label = 'In progress'; cdLabel = 'Ends in'; cd = epochAt(t, e);
      body = `<div class="hero-actions">${intentionHTML(b)}<div class="progress"><i data-from="${epochAt(t, s)}" data-to="${epochAt(t, e)}"></i></div>
        <p class="hero-note">Checked in at ${b.doneAt}. Stay on it.</p></div>`;
    } else if (f.mode === 'missed-running') {
      const nx = nextPendingAfter(b);
      label = 'Missed'; cdLabel = 'Ends in'; cd = epochAt(t, e);
      body = `<div class="hero-actions"><p class="warn-text">You missed this check-in. It's on the record.</p>
        <p class="hero-note">${nx ? `Next: <b>${esc(nx.emoji)} ${esc(nx.title)}</b> — check-in opens at ${fmtMin(Math.max(0, toMin(nx.start) - d.early))}. Don't miss it.` : 'Use the rest of this block anyway.'}</p></div>`;
    } else {
      label = 'Up next'; cdLabel = 'Check-in opens in'; cd = epochAt(t, s - d.early);
      body = `<div class="hero-actions"><p class="hero-note">Check-in window: <span class="mono">${fmtMin(Math.max(0, s - d.early))} – ${fmtMin(s + d.grace)}</span></p></div>`;
    }
    return `<div class="hero-inner ${f.mode}" style="--c:${cat.color}">
      <p class="eyebrow"><span class="live-dot"></span>${label}</p>
      <h2 class="hero-title"><span class="emoji">${esc(b.emoji)}</span>${esc(b.title)}</h2>
      <p class="hero-time mono">${b.start} – ${b.end} · ${cat.label} · ${e - s} min</p>
      <div class="countdown"><span class="muted small">${cdLabel}</span><span class="mono big" data-cd="${cd}">--:--</span></div>
      ${body}
    </div>`;
  }

  const RATINGS = { 3: { label: 'Nailed it', emoji: '🔥' }, 2: { label: 'Partly', emoji: '👍' }, 1: { label: 'Slipped', emoji: '😕' } };

  function intentionHTML(b) {
    if (b.intention) return `<p class="intention">🎯 <span>${esc(b.intention)}</span></p>`;
    return `<form data-form="intention" class="intention-form" autocomplete="off">
      <input type="hidden" name="id" value="${b.id}">
      <input type="text" name="text" maxlength="120" placeholder="What exactly will you finish in this block?" aria-label="Block intention">
      <button class="btn sm" type="submit">Set</button></form>`;
  }

  function reviewStripHTML() {
    const b = blockNeedingReview();
    if (!b) return '';
    return `<div class="review-strip" style="--c:${(CATS[b.cat] || CATS.focus).color}">
      <div class="grow"><p class="eyebrow" style="margin:0">Block review</p>
        <b>How did ${esc(b.emoji)} ${esc(b.title)} go?</b>${b.intention ? `<div class="muted small">Intention: ${esc(b.intention)}</div>` : ''}</div>
      <div class="row">${[3, 2, 1].map(v => `<button class="btn sm" data-action="rate" data-id="${b.id}" data-v="${v}">${RATINGS[v].emoji} ${RATINGS[v].label}</button>`).join('')}</div>
    </div>`;
  }

  function prioritiesHTML(t) {
    const pr = state.priorities[t] || [];
    const now = Date.now();
    return `<div class="card">
      <div class="card-head"><h2>Top 3 priorities</h2><span class="muted small">${pr.filter(p => p.done).length}/${pr.length || 3} done</span></div>
      ${pr.length ? `<ul class="habit-list">${pr.map((p, i) => `<li class="prio-item">
        <button class="habit-toggle${p.done ? ' on' : ''}" data-action="prio-toggle" data-id="${p.id}" aria-pressed="${!!p.done}">
          <span class="box">${ICON.check}</span><span class="prio-n mono">${i + 1}</span><span class="name">${esc(p.text)}</span></button>
        ${!p.done && now - (p.at || 0) < PRIO_EDIT_MS ? `<button class="btn icon ghost" data-action="prio-remove" data-id="${p.id}" aria-label="Remove priority" title="Remove (only right after adding)">${ICON.x}</button>` : ''}
      </li>`).join('')}</ul>` : `<p class="muted small" style="margin-bottom:12px">Name the 3 outcomes that make today a win. Once set, they're locked in — unfinished ones roll into tomorrow's inbox.</p>`}
      ${pr.length < 3 ? `<form data-form="priority" class="inline-add" autocomplete="off" ${pr.length ? 'style="margin-top:10px"' : ''}>
        <input type="text" name="text" maxlength="100" placeholder="Priority ${pr.length + 1}: what must get done today?" aria-label="New priority">
        <button class="btn primary sm" type="submit">Add</button></form>` : ''}
    </div>`;
  }

  function pomoHTML() {
    const p = state.pomo, cnt = state.pomos[todayKey()] || 0;
    const F = state.settings.pomoFocus, B = state.settings.pomoBreak;
    let label, time, bar = '', btns;
    if (!p) {
      label = 'Ready'; time = `<span class="mono pomo-time">${pad(F)}:00</span>`;
      btns = `<button class="btn primary sm" data-action="pomo-start">▶ Start ${F}-min focus</button>`;
    } else if (p.paused) {
      label = p.phase === 'focus' ? 'Focus · paused' : 'Break · paused';
      time = `<span class="mono pomo-time">${fmtDur(p.remaining)}</span>`;
      btns = `<button class="btn primary sm" data-action="pomo-resume">▶ Resume</button><button class="btn sm ghost" data-action="pomo-stop">Reset</button>`;
    } else {
      label = p.phase === 'focus' ? 'Focus session' : 'Break';
      time = `<span class="mono pomo-time" data-cd="${p.endsAt}">--:--</span>`;
      bar = `<div class="progress" style="--c:${p.phase === 'focus' ? 'var(--accent)' : 'var(--good)'}"><i data-from="${p.endsAt - p.dur}" data-to="${p.endsAt}"></i></div>`;
      btns = p.phase === 'focus'
        ? `<button class="btn sm" data-action="pomo-pause">❚❚ Pause</button><button class="btn sm ghost" data-action="pomo-stop">Reset</button>`
        : `<button class="btn sm" data-action="pomo-stop">Skip break</button>`;
    }
    return `<div class="pomo ${p ? p.phase : 'idle'}">
      <div class="row" style="justify-content:space-between"><span class="eyebrow" style="margin:0">🍅 ${label}</span>
        <span class="pomo-count" title="${cnt} focus sessions today">${'●'.repeat(Math.min(cnt, 8))}${cnt > 8 ? ` +${cnt - 8}` : ''}${cnt ? '' : '<span class="faint">no sessions yet</span>'}</span></div>
      ${time}${bar}
      <div class="row">${btns}</div>
      <p class="faint small">${F} min focus · ${B} min break</p>
    </div>`;
  }

  function inboxHTML() {
    const items = state.inbox;
    const shown = ui.inboxAll ? items : items.slice(0, 6);
    const prCount = (state.priorities[todayKey()] || []).length;
    return `<div class="card">
      <div class="card-head"><h2>Inbox</h2><span class="muted small">Press <kbd>N</kbd> anywhere to capture</span></div>
      <form data-form="capture" class="inline-add" autocomplete="off">
        <input type="text" name="text" maxlength="160" placeholder="Capture a task or idea — deal with it later" aria-label="Capture to inbox">
        <button class="btn sm" type="submit">Capture</button></form>
      ${items.length ? `<ul class="inbox-list">${shown.map(it => `<li>
        <button class="mini-check" data-action="inbox-done" data-id="${it.id}" aria-label="Mark done" title="Done">${ICON.check}</button>
        <span class="grow"><span class="it-text">${esc(it.text)}</span>${it.from ? `<span class="chip warn carried">↻ from ${fmtDateShort(it.from)}</span>` : ''}</span>
        ${prCount < 3 ? `<button class="btn icon ghost" data-action="inbox-promote" data-id="${it.id}" aria-label="Make a priority today" title="Make today's priority">★</button>` : ''}
        <button class="btn icon ghost" data-action="inbox-delete" data-id="${it.id}" aria-label="Delete" title="Delete">${ICON.trash}</button>
      </li>`).join('')}</ul>
      ${items.length > 6 ? `<button class="link small" data-action="inbox-more">${ui.inboxAll ? 'Show less' : `Show all ${items.length}`}</button>` : ''}`
        : `<p class="muted small" style="margin-top:12px">Empty inbox. Clear mind.</p>`}
    </div>`;
  }

  function shutdownHTML(t) {
    const r = state.reviews[t];
    if (r) {
      const tm = (state.priorities[addDays(t, 1)] || []).length;
      return `<div class="card shutdown done"><div class="card-head" style="margin-bottom:6px"><h2>🌙 Shutdown complete</h2><span class="chip good">${r.rating}/10</span></div>
        <p class="muted small">${tm ? `Tomorrow's ${plural(tm, 'priority', 'priorities')} ${tm === 1 ? 'is' : 'are'} set.` : 'No priorities set for tomorrow yet.'} <button class="link small" data-action="shutdown">Edit</button></p></div>`;
    }
    const f = currentFocus();
    const evening = new Date().getHours() >= 17 || f.mode === 'finished';
    if (!evening) return '';
    return `<div class="card shutdown">
      <p class="eyebrow">Evening ritual</p>
      <h2 style="margin-bottom:6px">Close the day with intent</h2>
      <p class="muted small" style="margin-bottom:14px">Rate today, capture wins and one lesson, and set tomorrow's top 3 so you wake up knowing exactly what to do.</p>
      <button class="btn primary" data-action="shutdown">🌙 Start shutdown ritual</button>
    </div>`;
  }

  function timelineHTML(d) {
    if (!d || !d.blocks.length) return `<div class="empty">No blocks scheduled today.</div>`;
    const nm = nowMin();
    return `<ol class="timeline">${d.blocks.map(b => {
      const s = toMin(b.start), e = toMin(b.end), cat = CATS[b.cat] || CATS.focus;
      const open = b.status === 'pending' && nm >= s - d.early && nm <= s + d.grace;
      const now = nm >= s && nm < e;
      let act;
      if (b.status === 'done') act = `<span class="chip good">${ICON.check} ${esc(b.doneAt)}</span>`;
      else if (b.status === 'missed') act = `<span class="chip bad">Missed</span>`;
      else if (open) act = `<button class="btn primary sm" data-action="checkin" data-id="${b.id}">Check in</button>`;
      else act = `<span class="chip">Opens ${fmtMin(Math.max(0, s - d.early))}</span>`;
      const undo = b.status === 'done' && Date.now() - (b.doneTs || 0) < UNDO_MS
        ? `<button class="link small" data-action="undo" data-id="${b.id}">Undo</button>` : '';
      return `<li class="tl-item ${b.status}${now ? ' now' : ''}${open ? ' open' : ''}" style="--c:${cat.color}">
        <div class="tl-time mono">${b.start}<small>${b.end}</small></div>
        <div class="tl-dot"></div>
        <div style="min-width:0"><div class="tl-title"><span class="emoji">${esc(b.emoji)}</span>${esc(b.title)}</div>
          <div class="tl-meta">${cat.label} · ${e - s} min${b.rating ? ` · ${RATINGS[b.rating].emoji} ${RATINGS[b.rating].label}` : ''}${b.intention ? ` · 🎯 ${esc(b.intention)}` : ''}</div></div>
        <div class="tl-act">${undo}${act}</div>
      </li>`;
    }).join('')}</ol>`;
  }

  function todayHabitsHTML(t) {
    const hs = activeHabits(t);
    if (!hs.length) return `<div class="empty">No habits yet. <a href="#habits">Add some</a>.</div>`;
    const log = state.habitLog[t] || {};
    return `<ul class="habit-list">${hs.map(h => {
      const st = habitStreak(h);
      return `<li><button class="habit-toggle${log[h.id] ? ' on' : ''}" data-action="habit" data-id="${h.id}" aria-pressed="${!!log[h.id]}">
        <span class="box">${ICON.check}</span><span class="emoji" style="margin:0">${esc(h.emoji)}</span>
        <span class="name">${esc(h.name)}</span><span class="streak${st ? '' : ' zero'}">${st}🔥</span></button></li>`;
    }).join('')}</ul>`;
  }

  /* ---------- views ---------- */
  function viewToday() {
    const t = todayKey(), d = state.days[t], st = dayStats(t), f = currentFocus();
    const hr = new Date().getHours();
    const greet = hr < 5 ? 'Still up' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    const name = state.settings.name ? `, ${esc(state.settings.name)}` : '';
    const pend = state.schedule.pending;
    const streak = disciplineStreak();
    const log = state.habitLog[t] || {};
    const yest = addDays(t, -1);
    const missedReview = yest >= state.createdAt && !!state.days[yest] && !state.reviews[yest] && !state.reviews[t];
    return `
      <header class="page-head">
        <div><p class="eyebrow">${fmtDateLong(t)}</p><h1>${greet}${name}.</h1></div>
        <div class="head-actions">
          <button class="btn ghost" data-action="capture" title="Quick capture (N)">＋ Capture</button>
          <button class="btn" data-action="focus" title="Focus mode (F)">${ICON.focus} Focus mode</button>
        </div>
      </header>
      ${quoteHTML()}
      ${pend && !weekIsEmpty(state.schedule.active) ? `<div class="banner">${ICON.lock}<span class="grow">Your updated plan locks in on <b>${fmtDateShort(pend.effective)}</b>. Today runs on the schedule you committed to.</span></div>` : ''}
      <section class="grid-today">
        <div class="card hero">${heroHTML(f)}</div>
        <div class="card score-card">
          ${ringHTML(st.score)}
          <div class="score-grid">
            <div class="g"><b>${st.bDone}</b><span>On time</span></div>
            <div class="r"><b>${st.bMissed}</b><span>Missed</span></div>
            <div><b>${st.bPending}</b><span>Left</span></div>
            <div><b>${st.hDone}/${st.hTotal}</b><span>Habits</span></div>
            <div><b>${st.pDone}/${st.pTotal}</b><span>Priorities</span></div>
            <div><b>${streak}</b><span>Day streak</span></div>
          </div>
        </div>
      </section>
      ${missedReview ? `<div class="banner warn">${ICON.alert}<span class="grow">You skipped yesterday's shutdown ritual. Tonight, close the day properly — it's how tomorrow gets planned.</span></div>` : ''}
      <section class="grid-2">
        <div class="stack">
          ${prioritiesHTML(t)}
          <div class="card">
            <div class="card-head"><h2>Today's schedule</h2><span class="muted small">${st.bTotal ? `${st.bDone}/${st.bTotal} on time` : ''}</span></div>
            ${reviewStripHTML()}
            ${timelineHTML(d)}
          </div>
        </div>
        <div class="stack">
          ${shutdownHTML(t)}
          <div class="card">${pomoHTML()}</div>
          <div class="card">
            <div class="card-head"><h2>Daily habits</h2><span class="muted small">${activeHabits(t).filter(h => log[h.id]).length}/${activeHabits(t).length} done</span></div>
            ${todayHabitsHTML(t)}
          </div>
          ${inboxHTML()}
        </div>
      </section>`;
  }

  function viewHabits() {
    const { y, m } = ui.month;
    const n = new Date(y, m + 1, 0).getDate();
    const keys = Array.from({ length: n }, (_, i) => dkey(new Date(y, m, i + 1)));
    const t = todayKey(), mStart = keys[0], mEnd = keys[n - 1];
    const hs = state.habits.filter(h => h.created <= mEnd && (!h.archived || h.archived > mStart));
    const cur = new Date();
    const isCurMonth = y === cur.getFullYear() && m === cur.getMonth();

    const groups = [];
    keys.forEach((k, i) => { if (i === 0 || parseKey(k).getDay() === 1) groups.push(0); groups[groups.length - 1]++; });
    const wsClass = (k, i) => (i > 0 && parseKey(k).getDay() === 1) ? ' ws' : '';

    const cellState = (h, k) => {
      if (k < h.created || (h.archived && k >= h.archived) || k < state.createdAt) return 'na';
      if (k > t) return 'future';
      const done = !!(state.habitLog[k] && state.habitLog[k][h.id]);
      if (k === t) return done ? 'today done' : 'today';
      return done ? 'done' : 'miss';
    };

    const rows = hs.map(h => {
      let done = 0, elig = 0;
      const cells = keys.map((k, i) => {
        const cs = cellState(h, k);
        if (cs !== 'na' && cs !== 'future') { elig++; if (cs.includes('done')) done++; }
        const inner = cs.includes('done') ? ICON.check : '';
        const title = `${esc(h.name)} — ${fmtDateShort(k)}`;
        const cell = cs.startsWith('today')
          ? `<button class="cell ${cs}" data-action="habit" data-id="${h.id}" title="${title}" aria-label="${title}" aria-pressed="${cs.includes('done')}">${inner}</button>`
          : `<div class="cell ${cs}" title="${title}">${inner}</div>`;
        return `<td class="${wsClass(k, i).trim()}">${cell}</td>`;
      }).join('');
      return `<tr><td class="hname" title="${esc(h.name)}"><span class="emoji">${esc(h.emoji)}</span>${esc(h.name)}</td>${cells}
        <td class="pct"><b>${elig ? Math.round(done / elig * 100) : 0}%</b> · ${habitStreak(h)}🔥</td></tr>`;
    }).join('');

    const dayBars = keys.map((k, i) => {
      const act = hs.filter(h => { const c = cellState(h, k); return c !== 'na' && c !== 'future'; });
      if (!act.length) return `<td class="${wsClass(k, i).trim()}"><div class="dbar" style="opacity:.35"></div></td>`;
      const dn = act.filter(h => state.habitLog[k] && state.habitLog[k][h.id]).length;
      const p = dn / act.length;
      return `<td class="${wsClass(k, i).trim()}"><div class="dbar" title="${fmtDateShort(k)}: ${Math.round(p * 100)}%"><i style="height:${Math.max(p * 100, p ? 8 : 0)}%"></i></div></td>`;
    }).join('');

    const active = state.habits.filter(h => !h.archived);
    return `
      <header class="page-head">
        <div><p class="eyebrow">Habit tracker</p><h1>My habits</h1>
          <p class="sub">Only today can be ticked. Every past day is permanent — that's the point.</p></div>
        <div class="month-nav">
          <button class="btn icon" data-action="month" data-dir="-1" aria-label="Previous month">${ICON.chevL}</button>
          <h2>${MONTHS[m]} ${y}</h2>
          <button class="btn icon" data-action="month" data-dir="1" aria-label="Next month" ${isCurMonth ? 'disabled' : ''}>${ICON.chevR}</button>
          ${isCurMonth ? '' : `<button class="btn sm" data-action="month" data-dir="0">Today</button>`}
        </div>
      </header>
      <div class="card" style="margin-bottom:20px">
        ${hs.length ? `<div class="hgrid-wrap"><table class="hgrid">
          <thead>
            <tr><th class="hname title" rowspan="3">My Habits</th>${groups.map((g, i) => `<th colspan="${g}" class="${i ? 'ws' : ''}"><div class="wk">Week ${i + 1}</div></th>`).join('')}<th rowspan="3" class="pct">Month</th></tr>
            <tr>${keys.map((k, i) => `<th class="dow${k === t ? ' today' : ''}${wsClass(k, i)}">${DOW_SHORT[parseKey(k).getDay()].slice(0, 2)}</th>`).join('')}</tr>
            <tr>${keys.map((k, i) => `<th class="dnum${k === t ? ' today' : ''}${wsClass(k, i)}">${i + 1}</th>`).join('')}</tr>
          </thead>
          <tbody>${rows}
            <tr><td class="hname muted small">Daily completion</td>${dayBars}<td></td></tr>
          </tbody>
        </table></div>
        <div class="legend">
          <span><span class="cell done">${ICON.check}</span>Done</span>
          <span><span class="cell miss"></span>Missed</span>
          <span><span class="cell today"></span>Today (tap to tick)</span>
          <span><span class="cell future"></span>Upcoming</span>
        </div>` : `<div class="empty">No habits tracked in this month.</div>`}
      </div>
      <div class="card">
        <div class="card-head"><h2>Manage habits</h2><span class="muted small">${active.length} active</span></div>
        ${active.length ? `<ul class="manage-list">${active.map(h => `
          <li><span style="font-size:18px">${esc(h.emoji)}</span><span class="name">${esc(h.name)}</span>
            <span class="muted small">since ${fmtDateShort(h.created)}</span>
            <button class="btn icon ghost" data-action="habit-edit" data-id="${h.id}" aria-label="Edit ${esc(h.name)}" title="Edit">${ICON.edit}</button>
            <button class="btn icon ghost" data-action="habit-archive" data-id="${h.id}" aria-label="Archive ${esc(h.name)}" title="Archive">${ICON.archive}</button>
          </li>`).join('')}</ul>` : ''}
        <form data-form="habit-add" class="add-row" autocomplete="off">
          <label class="f">Emoji<input type="text" name="emoji" maxlength="8" placeholder="✨"></label>
          <label class="f">New habit<input type="text" name="name" maxlength="50" placeholder="e.g. Cold shower" required></label>
          <button class="btn primary" type="submit">Add habit</button>
        </form>
      </div>`;
  }

  function planBase() { return state.schedule.pending ? state.schedule.pending.days : state.schedule.active; }
  function getDraft() { if (!state.draft) state.draft = clone(planBase()); return state.draft; }
  function draftDirty() { return !!state.draft && JSON.stringify(state.draft) !== JSON.stringify(planBase()); }
  const isFirstSetup = () => weekIsEmpty(state.schedule.active) && !state.schedule.pending;

  function viewPlan() {
    const draft = getDraft();
    const wd = ui.planDay;
    const list = draft[wd];
    const dirty = draftDirty();
    const first = isFirstSetup();
    const pend = state.schedule.pending;
    const tomorrow = addDays(todayKey(), 1);
    const editing = ui.editId ? list.find(b => b.id === ui.editId) : null;
    if (ui.editId && !editing) ui.editId = null;

    const lastEnd = list.length ? toMin(list[list.length - 1].end) : 360;
    const defStart = editing ? editing.start : fmtMin(Math.min(lastEnd, 1380));
    const defEnd = editing ? editing.end : fmtMin(Math.min(toMin(defStart) + 60, 1439));
    const todayWd = new Date().getDay();

    const hours = [0, 6, 12, 18, 24];
    const strip = `<div class="strip" aria-hidden="true">
      ${[3, 6, 9, 12, 15, 18, 21].map(h => `<span class="hr" style="left:${h / 24 * 100}%"></span>`).join('')}
      ${list.map(b => `<span class="seg${b.id === ui.editId ? ' editing' : ''}" title="${esc(b.title)} ${b.start}–${b.end}" style="--c:${(CATS[b.cat] || CATS.focus).color};left:${toMin(b.start) / 1440 * 100}%;width:${(toMin(b.end) - toMin(b.start)) / 1440 * 100}%"></span>`).join('')}
      ${hours.map(h => `<span class="tick${h === 24 ? ' end' : ''}" style="left:${h / 24 * 100}%">${pad(h)}:00</span>`).join('')}
    </div>`;

    let banner;
    if (first) banner = `<div class="banner">${ICON.info}<span class="grow"><b>First setup.</b> Your first schedule activates the moment you commit it. After that, every change waits until the next day.</span></div>`;
    else if (pend) banner = `<div class="banner">${ICON.lock}<span class="grow"><b>Committed changes lock in on ${fmtDateShort(pend.effective)}.</b> Today stays exactly as planned. You can still revise before then.</span><button class="btn sm ghost" data-action="cancel-pending">Revert to current plan</button></div>`;
    else banner = `<div class="banner">${ICON.lock}<span class="grow"><b>Commitment lock:</b> today's schedule is frozen. Changes you commit take effect <b>${fmtDateShort(tomorrow)}</b>.</span></div>`;

    return `
      <header class="page-head">
        <div><p class="eyebrow">Weekly plan</p><h1>Design your week</h1>
          <p class="sub">Time-block every day. Each block becomes a check-in you must hit.</p></div>
        <div class="head-actions">
          <button class="btn" data-action="wizard">${ICON.spark} Build with wizard</button>
          <button class="btn primary" data-action="commit" ${dirty ? '' : 'disabled'}>${ICON.lock} ${first ? 'Activate schedule' : 'Commit changes'}</button>
        </div>
      </header>
      ${banner}
      ${dirty ? `<div class="banner warn">${ICON.alert}<span class="grow">You have <b>uncommitted changes</b>. They do nothing until you commit.</span><button class="btn sm ghost" data-action="discard-draft">Discard</button></div>` : ''}
      <div class="tabs" role="tablist">
        ${DAY_ORDER.map(i => {
          const mins = draft[i].reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);
          return `<button class="tab${i === wd ? ' active' : ''}${i === todayWd ? ' today' : ''}" role="tab" aria-selected="${i === wd}" data-action="plan-day" data-day="${i}">
            <b>${DOW_SHORT[i]}</b><small>${draft[i].length} · ${Math.floor(mins / 60)}h${mins % 60 ? pad(mins % 60) : ''}</small></button>`;
        }).join('')}
      </div>
      <div class="card">
        <div class="card-head"><h2>${DOW_LONG[wd]}</h2>
          <div class="row">${list.length ? `<button class="btn sm ghost" data-action="day-clear">${ICON.trash} Clear day</button>` : ''}</div></div>
        ${strip}
        ${list.length ? `<ul class="blist">${list.map(b => {
          const cat = CATS[b.cat] || CATS.focus;
          return `<li class="brow${b.id === ui.editId ? ' editing' : ''}" style="--c:${cat.color}">
            <span class="mono tm">${b.start} – ${b.end}</span>
            <span class="t"><span class="emoji">${esc(b.emoji)}</span>${esc(b.title)}</span>
            <span class="chip">${cat.label} · ${toMin(b.end) - toMin(b.start)}m</span>
            <span class="acts">
              <button class="btn icon ghost" data-action="block-edit" data-id="${b.id}" aria-label="Edit ${esc(b.title)}" title="Edit">${ICON.edit}</button>
              <button class="btn icon ghost" data-action="block-delete" data-id="${b.id}" aria-label="Delete ${esc(b.title)}" title="Delete">${ICON.trash}</button>
            </span></li>`;
        }).join('')}</ul>` : `<div class="empty" style="margin-bottom:20px">No blocks on ${DOW_LONG[wd]} yet. Add your first one below.</div>`}
        <form data-form="block" class="block-form" autocomplete="off">
          <label class="f">Start<input type="time" name="start" value="${defStart}" required></label>
          <label class="f">End<input type="time" name="end" value="${defEnd}" required></label>
          <label class="f emoji-f">Emoji<input type="text" name="emoji" maxlength="8" value="${editing ? esc(editing.emoji) : ''}" placeholder="🎯"></label>
          <label class="f title-f">Block<input type="text" name="title" maxlength="60" value="${editing ? esc(editing.title) : ''}" placeholder="e.g. Deep work — thesis" required></label>
          <label class="f cat-f">Category<select name="cat">${Object.entries(CATS).map(([k, c]) => `<option value="${k}"${(editing ? editing.cat : 'focus') === k ? ' selected' : ''}>${c.label}</option>`).join('')}</select></label>
          <div class="actions">
            ${editing ? `<button class="btn ghost" type="button" data-action="block-cancel">Cancel</button>` : ''}
            <button class="btn primary" type="submit">${editing ? 'Save block' : '+ Add block'}</button>
          </div>
        </form>
        <form data-form="copy" class="copy-row">
          <span class="muted small">Copy ${DOW_LONG[wd]} to</span>
          <div class="daychips">${DAY_ORDER.map(i => `<label class="daychip"><input type="checkbox" name="to" value="${i}" ${i === wd ? 'disabled' : ''}><span>${DOW_SHORT[i].slice(0, 2)}</span></label>`).join('')}</div>
          <button class="btn sm" type="submit" ${list.length ? '' : 'disabled'}>Copy</button>
        </form>
      </div>`;
  }

  function viewStats() {
    const t = todayKey();
    const valid = k => k >= state.createdAt && k <= t;
    const range = n => Array.from({ length: n }, (_, i) => addDays(t, -(n - 1 - i)));
    const avg = keys => {
      const sc = keys.filter(valid).map(k => dayStats(k).score).filter(s => s !== null);
      return sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : null;
    };
    const last30 = range(30).filter(valid);
    let bDone = 0, bMiss = 0, hDone = 0, hTot = 0;
    for (const k of last30) {
      const s = dayStats(k);
      bDone += s.bDone; bMiss += s.bMissed;
      hDone += s.hDone; hTot += k === t ? s.hDone : s.hTotal;
    }
    const today = dayStats(t);

    // Heatmap: 18 week columns, Monday-first, last column contains today.
    const dow = (parseKey(t).getDay() + 6) % 7;
    const hStart = addDays(t, -dow - 7 * 17);
    const heat = Array.from({ length: 18 * 7 }, (_, i) => {
      const k = addDays(hStart, i);
      if (k > t) return `<i class="fut"></i>`;
      const s = valid(k) ? dayStats(k).score : null;
      const lv = s === null ? '' : s === 0 ? 'l0' : s < 0.5 ? 'l1' : s < GOOD_DAY ? 'l2' : s < 1 ? 'l3' : 'l4';
      return `<i class="${lv}${k === t ? ' today' : ''}" title="${fmtDateShort(k)}: ${pct(s)}"></i>`;
    }).join('');

    const bars = range(14).map(k => {
      const s = valid(k) ? dayStats(k).score : null;
      const cls = s === null ? 'none' : s < 0.5 ? 'low' : '';
      return `<div class="bar${k === t ? ' today' : ''}" title="${fmtDateShort(k)}: ${pct(s)}">
        <div class="col ${cls}" style="height:${s === null ? 3 : Math.max(s * 100, 3)}%"></div>
        <small>${parseKey(k).getDate()}</small></div>`;
    }).join('');

    const habitRows = state.habits.filter(h => !h.archived).map(h => {
      let d = 0, e = 0;
      for (const k of last30) {
        if (k < h.created) continue;
        const done = !!(state.habitLog[k] && state.habitLog[k][h.id]);
        if (k === t && !done) continue;
        e++; if (done) d++;
      }
      const p = e ? d / e : 0;
      return `<div><div class="hbar-top"><span><span class="emoji">${esc(h.emoji)}</span>${esc(h.name)}</span><span class="mono muted">${d}/${e} · ${Math.round(p * 100)}%</span></div>
        <div class="progress" style="--c:${p >= GOOD_DAY ? 'var(--good)' : p >= 0.5 ? 'var(--accent)' : 'var(--warn)'}"><i style="width:${p * 100}%"></i></div></div>`;
    }).join('');

    const ex = state.excuses.slice().reverse().slice(0, 12);

    // Productivity metrics
    let pD = 0, pT = 0, rSum = 0, rN = 0;
    for (const k of last30) {
      const pr = state.priorities[k] || [];
      pD += pr.filter(p => p.done).length; pT += pr.length;
      for (const b of (state.days[k] ? state.days[k].blocks : [])) if (b.rating) { rSum += b.rating; rN++; }
    }
    const last7 = range(7).filter(valid);
    const pomos7 = last7.reduce((a, k) => a + (state.pomos[k] || 0), 0);
    const catMin = {};
    for (const k of last7) {
      for (const b of (state.days[k] ? state.days[k].blocks : [])) {
        const c = catMin[b.cat] || (catMin[b.cat] = { done: 0, planned: 0 });
        const m = toMin(b.end) - toMin(b.start);
        c.planned += m; if (b.status === 'done') c.done += m;
      }
    }
    const hrs = m => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`;
    const timeRows = Object.keys(CATS).filter(c => catMin[c]).map(c => {
      const { done, planned } = catMin[c], p = planned ? done / planned : 0;
      return `<div><div class="hbar-top"><span>${CATS[c].label}</span><span class="mono muted">${hrs(done)} of ${hrs(planned)}</span></div>
        <div class="progress" style="--c:${CATS[c].color}"><i style="width:${p * 100}%"></i></div></div>`;
    }).join('');
    const journal = Object.keys(state.reviews).sort().reverse().slice(0, 10);
    return `
      <header class="page-head">
        <div><p class="eyebrow">Performance</p><h1>Your record</h1>
          <p class="sub">A day counts as disciplined at ${Math.round(GOOD_DAY * 100)}%+ of blocks, habits and priorities completed.</p></div>
      </header>
      <section class="kpis">
        <div class="card kpi"><p class="eyebrow">Today</p><div class="v">${pct(today.score)}</div><div class="s">${today.bDone + today.hDone + today.pDone} of ${today.bTotal + today.hTotal + today.pTotal} done</div></div>
        <div class="card kpi"><p class="eyebrow">Priorities · 30d</p><div class="v">${pT ? Math.round(pD / pT * 100) + '%' : '—'}</div><div class="s">${pD} of ${pT} shipped</div></div>
        <div class="card kpi"><p class="eyebrow">Focus quality</p><div class="v">${rN ? (rSum / rN).toFixed(1) : '—'}<small class="muted" style="font-size:15px">${rN ? ' / 3' : ''}</small></div><div class="s">${plural(rN, 'block')} reviewed · 30d</div></div>
        <div class="card kpi"><p class="eyebrow">Pomodoros · 7d</p><div class="v">${pomos7}</div><div class="s">${hrs(pomos7 * state.settings.pomoFocus)} of timed focus</div></div>
        <div class="card kpi"><p class="eyebrow">Streak</p><div class="v">${disciplineStreak()}</div><div class="s">disciplined days · best ${bestStreak()}</div></div>
        <div class="card kpi"><p class="eyebrow">7-day avg</p><div class="v">${pct(avg(range(7)))}</div><div class="s">30-day avg ${pct(avg(range(30)))}</div></div>
        <div class="card kpi"><p class="eyebrow">Blocks · 30d</p><div class="v">${bDone + bMiss ? Math.round(bDone / (bDone + bMiss) * 100) + '%' : '—'}</div><div class="s">${bDone} on time · ${bMiss} missed</div></div>
        <div class="card kpi"><p class="eyebrow">Habits · 30d</p><div class="v">${hTot ? Math.round(hDone / hTot * 100) + '%' : '—'}</div><div class="s">${hDone} of ${hTot} completed</div></div>
      </section>
      <section class="stats-grid">
        <div class="card"><div class="card-head"><h2>Consistency</h2><span class="muted small">Last 18 weeks</span></div>
          <div class="heat-wrap"><div class="heat">${heat}</div></div>
          <div class="heat-legend"><span style="margin-right:6px">Less</span>
            <i style="background:rgba(248,113,113,.25)"></i><i style="background:rgba(122,162,255,.22)"></i><i style="background:rgba(122,162,255,.45)"></i><i style="background:rgba(122,162,255,.72)"></i><i style="background:#9db8ff"></i>
            <span style="margin-left:6px">More</span></div>
        </div>
        <div class="card"><div class="card-head"><h2>Daily score</h2><span class="muted small">Last 14 days</span></div>
          <div class="bars">${bars}</div></div>
      </section>
      <section class="stats-grid">
        <div class="card"><div class="card-head"><h2>Time invested</h2><span class="muted small">Executed vs planned · 7 days</span></div>
          ${timeRows ? `<div class="hbars">${timeRows}</div>` : `<div class="empty">No scheduled blocks yet.</div>`}</div>
        <div class="card"><div class="card-head"><h2>Habits</h2><span class="muted small">Last 30 days</span></div>
          ${habitRows ? `<div class="hbars">${habitRows}</div>` : `<div class="empty">No active habits.</div>`}</div>
      </section>
      <section class="stats-grid">
        <div class="card"><div class="card-head"><h2>Journal</h2><span class="muted small">Shutdown reviews</span></div>
          ${journal.length ? `<ul class="excuses journal">${journal.map(k => { const r = state.reviews[k]; return `<li>
            <div class="row small"><b>${fmtDateShort(k)}</b><span class="chip ${r.rating >= 7 ? 'good' : r.rating >= 4 ? 'accent' : 'bad'}">${r.rating}/10</span></div>
            ${r.wins ? `<p class="small" style="margin-top:6px"><b>Wins:</b> ${esc(r.wins)}</p>` : ''}
            ${r.lesson ? `<p class="small muted" style="margin-top:4px"><b>Lesson:</b> ${esc(r.lesson)}</p>` : ''}</li>`; }).join('')}</ul>` : `<div class="empty">Your evening reviews will appear here.</div>`}
        </div>
        <div class="card"><div class="card-head"><h2>Accountability log</h2><span class="muted small">${plural(state.excuses.length, 'entry', 'entries')}</span></div>
          ${ex.length ? `<ul class="excuses">${ex.map(e => `<li>
            <div class="row small"><b>${fmtDateShort(e.date)}</b><span class="muted">${plural(e.items.length, 'block')} missed: ${e.items.slice(0, 3).map(i => esc(i.title)).join(', ')}${e.items.length > 3 ? '…' : ''}</span></div>
            <q>${esc(e.reason)}</q></li>`).join('')}</ul>` : `<div class="empty">No misses on record. Keep it that way.</div>`}
        </div>
      </section>`;
  }

  function viewSettings() {
    const s = state.settings;
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    return `
      <header class="page-head"><div><p class="eyebrow">Preferences</p><h1>Settings</h1>
        <p class="sub">Window rules you change here apply from tomorrow — today's rules are locked.</p></div></header>
      <div class="settings-grid">
        <form class="card" data-form="settings">
          <div class="card-head"><h2>Rules & profile</h2></div>
          <div class="set-row"><div><b>Your name</b><div class="d">Used in your greeting.</div></div>
            <input type="text" name="name" maxlength="30" value="${esc(s.name)}" placeholder="Optional"></div>
          <div class="set-row"><div><b>Early check-in</b><div class="d">Minutes before a block when check-in opens (0–30).</div></div>
            <input type="number" name="early" min="0" max="30" step="1" value="${s.early}" required></div>
          <div class="set-row"><div><b>Grace period</b><div class="d">Minutes after start before the block is missed (1–60).</div></div>
            <input type="number" name="grace" min="1" max="60" step="1" value="${s.grace}" required></div>
          <div class="set-row"><div><b>Pomodoro focus</b><div class="d">Length of one focus session in minutes (5–90).</div></div>
            <input type="number" name="pomoFocus" min="5" max="90" step="1" value="${s.pomoFocus}" required></div>
          <div class="set-row"><div><b>Pomodoro break</b><div class="d">Break length in minutes (1–30).</div></div>
            <input type="number" name="pomoBreak" min="1" max="30" step="1" value="${s.pomoBreak}" required></div>
          <div class="set-row"><div><b>Sound alerts</b><div class="d">Chime when a window opens and closes soon.</div></div>
            <label class="check"><input type="checkbox" name="sound" ${s.sound ? 'checked' : ''}> On</label></div>
          <div class="set-row"><div><b>Desktop notifications</b><div class="d">${perm === 'denied' ? 'Blocked in browser settings — allow notifications for this page to enable.' : perm === 'unsupported' ? 'Not supported in this browser.' : 'Works while this tab is open (can be in the background).'}</div></div>
            <label class="check"><input type="checkbox" name="notify" ${s.notify && perm === 'granted' ? 'checked' : ''} ${perm === 'denied' || perm === 'unsupported' ? 'disabled' : ''}> On</label></div>
          <div class="modal-actions"><button class="btn ghost" type="button" data-action="test-alert">${ICON.bell} Test alert</button><button class="btn primary" type="submit">Save settings</button></div>
        </form>
        <div class="stack">
        ${accountCardHTML()}
        ${appCardHTML()}
        <div class="card">
          <div class="card-head"><h2>Your data</h2></div>
          <p class="muted small" style="margin-bottom:16px">${syncUser()
            ? 'Saved on this device and synced to your account. A backup file is still a good idea now and then.'
            : 'Everything is stored locally in this browser — nothing leaves your device. Export a backup regularly, and before clearing browser data.'}</p>
          <div class="row">
            <button class="btn" data-action="export">${ICON.download} Export backup</button>
            <label class="btn" tabindex="0">${ICON.upload} Import backup<input type="file" id="importFile" accept="application/json,.json" hidden></label>
          </div>
          <hr class="sep">
          <div class="card-head" style="margin-bottom:8px"><h3>Danger zone</h3></div>
          <p class="muted small" style="margin-bottom:14px">Erase your schedule, habits, and full history. This cannot be undone.</p>
          <button class="btn danger" data-action="reset">${ICON.trash} Reset everything</button>
        </div>
        </div>
      </div>`;
  }

  /* ---------- account & sync UI ---------- */
  const SYNC = () => window.SchedulaSync || { configured: false, state: 'off', user: null };
  const syncUser = () => SYNC().user;

  /** [label, tone] for the current sync status. */
  function syncLabel() {
    const s = SYNC();
    if (!s.configured) return ['Not set up', 'muted'];
    if (s.state === 'loading') return ['Starting…', 'muted'];
    if (s.state === 'unavailable') return ['Offline — sync paused', 'warn'];
    if (!s.user) return ['Local only', 'muted'];
    if (s.state === 'error') return ['Sync problem', 'bad'];
    if (s.state === 'choose') return ['Waiting for your choice', 'warn'];
    if (!navigator.onLine) return ['Offline — will sync', 'warn'];
    if (s.state === 'connecting' || s.state === 'syncing') return ['Syncing…', 'accent'];
    if (s.state === 'synced') return [`Synced${s.lastSyncAt ? ` · ${fmtMin(new Date(s.lastSyncAt).getHours() * 60 + new Date(s.lastSyncAt).getMinutes())}` : ''}`, 'good'];
    return ['Local only', 'muted'];
  }

  function syncChipHTML() {
    const s = SYNC();
    if (!s.configured) return '';
    const [label, tone] = syncLabel();
    return `<a class="side-stat sync-chip ${tone}" href="#settings" title="Account & sync">
      <span>${s.user ? '☁︎ Sync' : '☁︎ Account'}</span><b class="small">${s.user ? esc(label) : 'Sign in'}</b></a>`;
  }

  function accountCardHTML() {
    const s = SYNC();
    let body;
    if (!s.configured) {
      body = `<p class="muted small">Accounts keep your phone and desktop in sync. They aren't switched on for this copy of Schedula yet — the owner connects a free Firebase project once (see <b>SYNC_SETUP.md</b>). Until then, everything works on this device and you can move data with backups.</p>`;
    } else if (!s.user) {
      body = `<p class="muted small" style="margin-bottom:14px">Optional. Create a free account to use Schedula on your phone <b>and</b> desktop — your schedule, habits and history stay in sync, even after working offline.</p>
        ${s.state === 'unavailable' ? `<p class="small warn-text" style="margin-bottom:12px">${esc(s.error)}</p>` : ''}
        <div class="row">
          <button class="btn primary" data-action="auth-open" data-mode="signup" ${s.state === 'loading' || s.state === 'unavailable' ? 'disabled' : ''}>Create account</button>
          <button class="btn" data-action="auth-open" data-mode="signin" ${s.state === 'loading' || s.state === 'unavailable' ? 'disabled' : ''}>Sign in</button>
        </div>`;
    } else {
      const [label, tone] = syncLabel();
      const pending = window.SchedulaSync && window.SchedulaSync.pending ? window.SchedulaSync.pending() : 0;
      body = `<div class="set-row" style="padding-top:0"><div><b>${esc(s.user.name || 'Signed in')}</b><div class="d">${esc(s.user.email)}</div></div>
          <span class="chip ${tone}">${esc(label)}</span></div>
        ${s.state === 'error' && s.error ? `<p class="small warn-text" style="margin:10px 0">${esc(s.error)}</p>` : ''}
        ${pending ? `<p class="muted small" style="margin:10px 0">${plural(pending, 'change')} waiting to upload.</p>` : ''}
        <p class="muted small" style="margin:12px 0 14px">Sign in with the same account on your other devices. Changes appear there within seconds.</p>
        <div class="row">
          <button class="btn" data-action="sync-now">↻ Sync now</button>
          <button class="btn ghost" data-action="sign-out">Sign out</button>
        </div>`;
    }
    return `<div class="card"><div class="card-head"><h2>Account & sync</h2></div>${body}</div>`;
  }

  function openAuth(mode) {
    const s = SYNC();
    if (!s.configured) { toast('Sync is not set up yet — see SYNC_SETUP.md.', 'bad'); return; }
    const signup = mode === 'signup';
    openModal(`
      <button class="btn icon ghost close-x" data-action="close-modal" aria-label="Close">${ICON.x}</button>
      <p class="eyebrow">☁︎ Account</p>
      <h2>${signup ? 'Create your account' : 'Welcome back'}</h2>
      <p class="muted">${signup ? 'Sync your schedule between phone and desktop. Your data stays on this device too.' : 'Sign in to sync this device with your other ones.'}</p>
      <button class="btn google" type="button" data-action="auth-google">${GOOGLE_G} Continue with Google</button>
      <div class="or"><span>or with email</span></div>
      <form data-form="auth" class="stack" style="gap:12px" autocomplete="on" novalidate>
        <input type="hidden" name="mode" value="${signup ? 'signup' : 'signin'}">
        <label class="f">Email<input type="email" name="email" autocomplete="email" inputmode="email" required></label>
        <label class="f">Password<input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required></label>
        ${signup ? `<label class="f">Confirm password<input type="password" name="confirm" autocomplete="new-password" minlength="6" required></label>` : ''}
        <p class="form-error" id="authError" role="alert" hidden></p>
        <button class="btn primary" type="submit" id="authSubmit">${signup ? 'Create account' : 'Sign in'}</button>
      </form>
      <div class="row" style="justify-content:space-between;margin-top:14px">
        <button class="link small" data-action="auth-open" data-mode="${signup ? 'signin' : 'signup'}">${signup ? 'Have an account? Sign in' : 'New here? Create an account'}</button>
        ${signup ? '' : '<button class="link small" data-action="auth-reset">Forgot password?</button>'}
      </div>`, { kind: 'auth' });
  }

  function authError(msg) {
    const el = $('#authError');
    if (!el) { if (msg) toast(msg, 'bad'); return; }
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  async function runAuth(fn, okMsg) {
    const btns = $$('#modalRoot .btn');
    btns.forEach(b => { b.disabled = true; });
    authError('');
    try {
      await fn();
      closeModal();
      if (okMsg) toast(okMsg, 'good');
      render();
    } catch (e) {
      authError(SYNC().friendly ? SYNC().friendly(e) : String(e.message || e));
      btns.forEach(b => { b.disabled = false; });
    }
  }

  let linkResolve = null;
  function openLinkChoice() {
    openModal(`
      <p class="eyebrow">☁︎ Connect this device</p>
      <h2>Your account already has data</h2>
      <p class="muted">This device has its own data too. What should happen?</p>
      <div class="stack" style="gap:10px">
        <button class="btn primary choice" data-action="link-choice" data-mode="account">
          <b>Use my account's data</b><span>Recommended for a new phone. This device switches to what's in your account.</span></button>
        <button class="btn choice" data-action="link-choice" data-mode="merge">
          <b>Merge both</b><span>Keep everything from both. Matching habits are combined; your account's settings and schedule win.</span></button>
      </div>
      <p class="muted small" style="margin-top:14px">Not sure? <button class="link small" data-action="export">Download a backup of this device first</button>.</p>`,
    { kind: 'link', locked: true });
  }

  const GOOGLE_G = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7z"/>'
    + '<path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z"/>'
    + '<path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z"/>'
    + '<path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z"/></svg>';

  /** Bridge used by sync.js. */
  window.Schedula = {
    getState: () => state,
    applyState(next) {
      state = migrate(next);
      evaluate();
      save();
      if (!isTyping()) render();
      if (modalKind === 'focus') renderFocus();
      checkExcuses();
    },
    chooseLinkMode() {
      return new Promise(resolve => { linkResolve = resolve; openLinkChoice(); });
    },
    onSyncStatus() {
      const slot = $('#syncChipSlot');
      if (slot) slot.innerHTML = syncChipHTML();
      if (ui.view === 'settings' && !isTyping() && !modalKind) render();
    },
  };

  const VIEW_RENDER = { today: viewToday, habits: viewHabits, plan: viewPlan, stats: viewStats, settings: viewSettings };

  function navHTML() {
    return VIEWS.map(v => `<a href="#${v.id}" class="${ui.view === v.id ? 'active' : ''}" ${ui.view === v.id ? 'aria-current="page"' : ''}>${ICON[v.id]}<span>${v.label}</span></a>`).join('');
  }

  function render() {
    $('#nav').innerHTML = navHTML();
    $('#bottomnav').innerHTML = navHTML();
    const st = dayStats(todayKey());
    $('#sideFoot').innerHTML = `
      <div class="side-stat"><span>Today</span><b>${pct(st.score)}</b></div>
      <div class="side-stat"><span>Discipline streak</span><b>${disciplineStreak()}🔥</b></div>
      <div id="syncChipSlot">${syncChipHTML()}</div>
      ${pwa.installEvent && !isStandalone() ? `<button class="btn primary" data-action="install">${ICON.download} Install app</button>` : ''}`;
    $('#main').innerHTML = VIEW_RENDER[ui.view]();
    if (ui.view === 'habits') {
      // Keep today's column in view when the month is wider than the screen.
      const wrap = $('.hgrid-wrap'), cell = $('.hgrid .cell.today');
      if (wrap && cell) {
        const r = cell.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
        if (r.right > wr.right - 90) wrap.scrollLeft += r.right - wr.right + 90;
      }
    }
    ui.sig = focusSig();
    ui.minute = Math.floor(Date.now() / 60000);
    updateLive();
  }

  function renderFocus() {
    const m = $('.modal.focus-modal');
    if (!m) return;
    const t = todayKey(), st = dayStats(t);
    m.innerHTML = `<button class="btn icon ghost close-x" data-action="close-modal" aria-label="Exit focus mode">${ICON.x}</button>
      ${heroHTML(currentFocus())}
      <div class="focus-pomo">${pomoHTML()}</div>
      <p class="muted small" style="margin-top:22px">Today ${pct(st.score)} · ${st.bDone} on time · ${st.bMissed} missed · ${st.bPending} left</p>`;
    updateLive();
  }

  function updateLive() {
    const n = Date.now();
    $$('[data-cd]').forEach(el => { el.textContent = fmtDur(Number(el.dataset.cd) - n); });
    $$('[data-from]').forEach(el => {
      const a = Number(el.dataset.from), b = Number(el.dataset.to);
      el.style.width = `${clamp((n - a) / (b - a) * 100, 0, 100)}%`;
    });
    const f = currentFocus();
    if (f.mode === 'open') {
      const d = state.days[todayKey()];
      document.title = `⏳ ${fmtDur(epochAt(todayKey(), toMin(f.block.start) + d.grace) - n)} · Check in: ${f.block.title}`;
    } else if (f.mode === 'running') {
      document.title = `${fmtDur(epochAt(todayKey(), toMin(f.block.end)) - n)} · ${f.block.title} — Schedula`;
    } else if (state.pomo && !state.pomo.paused) {
      document.title = `🍅 ${fmtDur(state.pomo.endsAt - n)} · ${state.pomo.phase === 'focus' ? 'Focus' : 'Break'} — Schedula`;
    } else {
      document.title = 'Schedula';
    }
  }

  const isTyping = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };

  /* ---------- accountability ---------- */
  function checkExcuses() {
    const misses = unackedMisses();
    if (modalKind === 'excuse') {
      if (!misses.length) { closeModal(true); render(); toast('Answered on your other device.'); } // acknowledged elsewhere via sync
      return;
    }
    if (modalKind === 'link') return; // never interrupt the account-linking choice
    if (!misses.length) return;
    const shown = misses.slice(0, 8);
    openModal(`
      <p class="eyebrow" style="color:#fca5a5">${ICON.alert} Accountability check</p>
      <h2>You missed ${plural(misses.length, 'block')}.</h2>
      <p class="muted">No skipping this. Write down honestly why it happened and what you'll do differently. It goes on your record.</p>
      <ul class="miss-list">${shown.map(({ k, b }) => `<li><span class="mono small muted">${fmtDateShort(k)} ${b.start}</span><span class="grow">${esc(b.emoji)} ${esc(b.title)}</span></li>`).join('')}
        ${misses.length > shown.length ? `<li><span class="muted">…and ${misses.length - shown.length} more</span></li>` : ''}</ul>
      <form data-form="excuse">
        <label class="f">Why did this happen, and what will you change?
          <textarea name="reason" maxlength="600" placeholder="Be specific. 'I stayed up scrolling until 1am, so I slept through. Phone charges outside the bedroom from tonight.'" required></textarea></label>
        <div class="counter" id="reasonCounter">0 / ${EXCUSE_MIN} min</div>
        <div class="modal-actions"><button class="btn primary" type="submit" id="reasonBtn" disabled>Own it & continue</button></div>
      </form>`, { kind: 'excuse', locked: true });
  }

  /* ---------- wizard ---------- */
  function openWizard() {
    const dayChips = (name, days) => `<div class="daychips">${DAY_ORDER.map(i => `<label class="daychip"><input type="checkbox" name="${name}" value="${i}" ${days.includes(i) ? 'checked' : ''}><span>${DOW_SHORT[i].slice(0, 2)}</span></label>`).join('')}</div>`;
    openModal(`
      <button class="btn icon ghost close-x" data-action="close-modal" aria-label="Close">${ICON.x}</button>
      <p class="eyebrow">${ICON.spark} Schedule wizard</p>
      <h2>Build my schedule</h2>
      <p class="muted">Answer a few questions and get a complete week. You'll review and fine-tune it before committing.${draftDirty() ? ' <b>This replaces your uncommitted draft.</b>' : ''}</p>
      <form data-form="wizard" class="form-grid" autocomplete="off">
        <label class="f">Wake up<input type="time" name="wake" value="05:00" required></label>
        <label class="f">Lights out<input type="time" name="sleep" value="22:30" required></label>
        <fieldset class="full"><legend>Work / study</legend>
          <label class="f">Start<input type="time" name="workStart" value="09:00" required></label>
          <label class="f">End<input type="time" name="workEnd" value="17:00" required></label>
          <div class="full">${dayChips('workDays', [1, 2, 3, 4, 5])}</div>
        </fieldset>
        <fieldset class="full"><legend>Gym</legend>
          <label class="f">Time<input type="time" name="gymTime" value="06:00" required></label>
          <label class="f">Duration<select name="gymDur"><option value="30">30 min</option><option value="45">45 min</option><option value="60" selected>60 min</option><option value="75">75 min</option><option value="90">90 min</option></select></label>
          <div class="full">${dayChips('gymDays', [1, 2, 3, 4, 5, 6])}</div>
        </fieldset>
        <fieldset class="full"><legend>Growth</legend>
          <label class="f">Project work at<input type="time" name="projTime" value="18:30" required></label>
          <label class="f">Project duration<select name="projDur"><option value="0">None</option><option value="30">30 min</option><option value="60">60 min</option><option value="90" selected>90 min</option><option value="120">2 hours</option></select></label>
          <label class="f full">Reading before bed<select name="readMin"><option value="0">None</option><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">60 min</option></select></label>
        </fieldset>
        <div class="modal-actions full" style="margin-top:4px">
          <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
          <button class="btn primary" type="submit">${ICON.spark} Generate draft</button>
        </div>
      </form>`, { kind: 'wizard', cls: 'wide' });
  }

  function generate(o) {
    const W = toMin(o.wake), S = toMin(o.sleep);
    const week = emptyWeek();
    let dropped = 0, count = 0;
    for (let wd = 0; wd < 7; wd++) {
      const want = [];
      const add = (s, dur, title, emoji, cat) => { if (dur > 0) want.push({ s, e: s + dur, title, emoji, cat }); };
      // Priority order: earlier entries win overlaps.
      add(W, 15, 'Wake up & hydrate', '⏰', 'health');
      add(W + 15, 15, 'Plan the day', '🗓️', 'life');
      add(S - 15, 15, 'Review & shut down', '🌙', 'rest');
      if (o.workDays.has(wd)) {
        const ws = toMin(o.workStart), we = toMin(o.workEnd);
        if (ws <= 690 && we >= 840) {
          add(ws, 750 - ws, 'Deep work', '💼', 'focus');
          add(750, 30, 'Lunch break', '🥗', 'rest');
          add(780, we - 780, 'Deep work', '💼', 'focus');
        } else {
          add(ws, we - ws, 'Work / study', '💼', 'focus');
        }
      }
      if (o.gymDays.has(wd)) add(toMin(o.gymTime), o.gymDur, 'Gym', '💪', 'health');
      if (o.projDur > 0) add(toMin(o.projTime), o.projDur, 'Project work', '🎯', 'focus');
      if (o.readMin > 0) add(S - 15 - o.readMin, o.readMin, 'Reading', '📖', 'learning');

      const acc = [];
      for (const b of want) {
        if (b.s < W || b.e > S || b.e > 1439 || b.e <= b.s || acc.some(a => b.s < a.e && a.s < b.e)) { dropped++; continue; }
        acc.push(b);
      }
      acc.sort((a, b) => a.s - b.s);
      week[wd] = acc.map(b => ({ id: uid(), start: fmtMin(b.s), end: fmtMin(b.e), title: b.title, emoji: b.emoji, cat: b.cat }));
      count += acc.length;
    }
    return { week, dropped, count };
  }

  /* ---------- actions ---------- */
  function go(view) {
    if (location.hash !== `#${view}`) location.hash = view; // hashchange renders
    else { ui.view = view; render(); }
  }

  function checkIn(id) {
    evaluate();
    const t = todayKey(), d = state.days[t];
    const b = d && d.blocks.find(x => x.id === id);
    if (!b) { render(); return; }
    if (b.status !== 'pending') {
      toast(b.status === 'done' ? 'Already checked in.' : 'Too late — this window has closed.', 'bad');
      refresh(); return;
    }
    const nm = nowMin(), s = toMin(b.start);
    if (nm < s - d.early) { toast(`Check-in opens at ${fmtMin(s - d.early)}.`, 'bad'); return; }
    b.status = 'done';
    b.doneAt = fmtMin(Math.floor(nm));
    b.doneTs = Date.now();
    b.delta = Math.round(nm - s);
    save();
    chime('ok');
    toast(`Checked in: ${b.title}. Locked in.`, 'good');
    refresh();
  }

  function refresh() {
    render();
    if (modalKind === 'focus') renderFocus();
  }

  const ACTIONS = {
    'close-modal': () => closeModal(),
    'confirm-ok': () => { const fn = pendingConfirm; closeModal(); if (fn) fn(); },
    rate: el => {
      const d = state.days[todayKey()];
      const b = d && d.blocks.find(x => x.id === el.dataset.id);
      const v = Number(el.dataset.v);
      if (!b || b.status !== 'done' || !RATINGS[v]) return;
      b.rating = v;
      save(); refresh();
      toast(v === 3 ? 'Great block. Keep that energy.' : v === 2 ? 'Logged. Tighten the next one.' : 'Logged. What will you change next block?');
    },
    'prio-toggle': el => {
      const p = (state.priorities[todayKey()] || []).find(x => x.id === el.dataset.id);
      if (!p) return;
      p.done = !p.done;
      if (p.done) chime('ok');
      save(); render();
    },
    'prio-remove': el => {
      const t = todayKey(), pr = state.priorities[t] || [];
      const p = pr.find(x => x.id === el.dataset.id);
      if (!p) return;
      if (p.done || Date.now() - (p.at || 0) > PRIO_EDIT_MS) { toast('Priorities are locked once set. Finish it — or it rolls into tomorrow.', 'bad'); render(); return; }
      state.priorities[t] = pr.filter(x => x.id !== p.id);
      save(); render();
    },
    'pomo-start': () => {
      const dur = state.settings.pomoFocus * 60000;
      state.pomo = { phase: 'focus', endsAt: Date.now() + dur, dur };
      chime('ok'); save(); refresh();
    },
    'pomo-pause': () => {
      const p = state.pomo;
      if (!p || p.paused) return;
      state.pomo = { phase: p.phase, paused: true, remaining: Math.max(0, p.endsAt - Date.now()), dur: p.dur };
      save(); refresh();
    },
    'pomo-resume': () => {
      const p = state.pomo;
      if (!p || !p.paused) return;
      state.pomo = { phase: p.phase, endsAt: Date.now() + p.remaining, dur: p.dur };
      save(); refresh();
    },
    'pomo-stop': () => { state.pomo = null; save(); refresh(); },
    'inbox-done': el => {
      const it = state.inbox.find(x => x.id === el.dataset.id);
      if (!it) return;
      state.inbox = state.inbox.filter(x => x !== it);
      chime('ok'); save(); render(); toast(`Done: ${it.text}`, 'good');
    },
    'inbox-delete': el => { state.inbox = state.inbox.filter(x => x.id !== el.dataset.id); save(); render(); },
    'inbox-promote': el => {
      const t = todayKey(), pr = state.priorities[t] || (state.priorities[t] = []);
      const it = state.inbox.find(x => x.id === el.dataset.id);
      if (!it) return;
      if (pr.length >= 3) { toast('You already have 3 priorities today.', 'bad'); return; }
      pr.push({ id: uid(), text: it.text, done: false, at: Date.now() });
      state.inbox = state.inbox.filter(x => x !== it);
      save(); render(); toast("Promoted to today's priorities.", 'good');
    },
    'inbox-more': () => { ui.inboxAll = !ui.inboxAll; render(); },
    'quote-next': () => {
      if (QUOTES.length < 2) return;
      const daily = dailyQuoteIndex();
      const shown = ui.bonus ? ui.bonus.idx : daily;
      let n;
      do { n = Math.floor(Math.random() * QUOTES.length); } while (n === shown || n === daily);
      ui.bonus = { day: todayKey(), idx: n };
      ui.quoteAnim = true;
      render();
    },
    'quote-today': () => { ui.bonus = null; ui.quoteAnim = true; render(); },
    'auth-open': el => openAuth(el.dataset.mode),
    'auth-google': () => runAuth(() => SYNC().google(), 'Signed in — syncing.'),
    'auth-reset': () => {
      const email = String(($('#modalRoot input[name=email]') || {}).value || '').trim();
      if (!email) { authError('Type your email above first, then tap “Forgot password?”.'); return; }
      runAuth(() => SYNC().resetPassword(email), `Password reset email sent to ${email}.`);
    },
    'sign-out': () => confirmModal({
      title: 'Sign out?',
      body: 'Syncing stops on this device. Your data stays here and in your account — sign in again anytime to resume.',
      ok: 'Sign out',
      onOk: async () => { try { await SYNC().signOut(); toast('Signed out. This device is now local only.'); } catch (e) { toast(SYNC().friendly(e), 'bad'); } render(); },
    }),
    'sync-now': () => { SYNC().syncNow && SYNC().syncNow(); toast('Syncing…'); },
    'link-choice': el => {
      const resolve = linkResolve;
      linkResolve = null;
      closeModal(true);
      if (resolve) resolve(el.dataset.mode === 'merge' ? 'merge' : 'account');
      toast(el.dataset.mode === 'merge' ? 'Merging this device with your account…' : 'Loading your account data…');
    },
    install: async () => {
      const e = pwa.installEvent;
      if (!e) { toast("Use your browser's menu → Install Schedula.", 'bad'); return; }
      pwa.installEvent = null;
      try {
        e.prompt();
        const choice = await e.userChoice;
        if (choice.outcome !== 'accepted') toast('Install cancelled. You can install anytime from Settings.');
      } catch (err) { /* prompt unavailable */ }
      render();
    },
    'apply-update': el => {
      if (!pwa.waiting) { location.reload(); return; }
      el.disabled = true;
      pwa.waiting.postMessage('SKIP_WAITING'); // controllerchange → reload
    },
    capture: () => openCapture(),
    shutdown: () => openShutdown(),
    checkin: el => checkIn(el.dataset.id),
    undo: el => {
      const d = state.days[todayKey()];
      const b = d && d.blocks.find(x => x.id === el.dataset.id);
      if (!b || b.status !== 'done') return;
      if (Date.now() - (b.doneTs || 0) > UNDO_MS) { toast('Undo is only possible within 60 seconds.', 'bad'); refresh(); return; }
      b.status = 'pending';
      delete b.doneAt; delete b.doneTs; delete b.delta;
      evaluate(); save(); refresh();
      toast('Check-in undone.');
    },
    habit: el => {
      const t = todayKey();
      const h = activeHabits(t).find(x => x.id === el.dataset.id);
      if (!h) { toast('That habit can only be ticked for today.', 'bad'); return; }
      const log = state.habitLog[t] || (state.habitLog[t] = {});
      if (log[h.id]) delete log[h.id];
      else { log[h.id] = true; chime('ok'); }
      save(); render();
    },
    focus: () => {
      openModal('', { kind: 'focus', cls: 'focus-modal' });
      renderFocus();
    },
    wizard: () => { if (ui.view !== 'plan') go('plan'); openWizard(); },
    month: el => {
      const dir = Number(el.dataset.dir);
      const n = new Date();
      if (dir === 0) ui.month = { y: n.getFullYear(), m: n.getMonth() };
      else {
        const d = new Date(ui.month.y, ui.month.m + dir, 1);
        if (d > new Date(n.getFullYear(), n.getMonth(), 1)) return;
        ui.month = { y: d.getFullYear(), m: d.getMonth() };
      }
      render();
    },
    'habit-edit': el => {
      const h = state.habits.find(x => x.id === el.dataset.id);
      if (!h) return;
      openModal(`<h2>Edit habit</h2><p class="muted">Renaming keeps its full history.</p>
        <form data-form="habit-edit" class="add-row" autocomplete="off"><input type="hidden" name="id" value="${h.id}">
          <label class="f">Emoji<input type="text" name="emoji" maxlength="8" value="${esc(h.emoji)}"></label>
          <label class="f">Name<input type="text" name="name" maxlength="50" value="${esc(h.name)}" required></label>
          <button class="btn primary" type="submit">Save</button></form>`, { kind: 'habit-edit' });
    },
    'habit-archive': el => {
      const h = state.habits.find(x => x.id === el.dataset.id);
      if (!h) return;
      confirmModal({
        title: `Archive "${esc(h.name)}"?`,
        body: 'It stops appearing from today. Its history stays in your record. This cannot be reversed.',
        ok: 'Archive habit', danger: true,
        onOk: () => {
          const t = todayKey();
          if (h.created >= t) state.habits = state.habits.filter(x => x.id !== h.id); // created today: no history to keep
          else h.archived = t;
          if (state.habitLog[t]) delete state.habitLog[t][h.id];
          save(); render(); toast('Habit archived.');
        },
      });
    },
    'plan-day': el => { ui.planDay = Number(el.dataset.day); ui.editId = null; render(); },
    'block-edit': el => { ui.editId = el.dataset.id; render(); const i = $('form[data-form=block] input[name=title]'); if (i) { i.focus(); i.scrollIntoView({ block: 'center', behavior: 'smooth' }); } },
    'block-cancel': () => { ui.editId = null; render(); },
    'block-delete': el => {
      const list = getDraft()[ui.planDay];
      const i = list.findIndex(b => b.id === el.dataset.id);
      if (i < 0) return;
      list.splice(i, 1);
      if (ui.editId === el.dataset.id) ui.editId = null;
      save(); render();
    },
    'day-clear': () => confirmModal({
      title: `Clear ${DOW_LONG[ui.planDay]}?`, body: 'Removes every block on this day from your draft. Nothing changes until you commit.',
      ok: 'Clear day', danger: true,
      onOk: () => { getDraft()[ui.planDay] = []; ui.editId = null; save(); render(); },
    }),
    'discard-draft': () => confirmModal({
      title: 'Discard changes?', body: 'Your draft goes back to the last committed plan.', ok: 'Discard', danger: true,
      onOk: () => { state.draft = null; ui.editId = null; save(); render(); },
    }),
    'cancel-pending': () => confirmModal({
      title: 'Revert to your current plan?', body: 'The committed-but-not-yet-active changes are dropped. Your current schedule keeps running.', ok: 'Revert',
      onOk: () => { state.schedule.pending = null; state.draft = null; save(); render(); toast('Pending changes dropped.'); },
    }),
    commit: () => {
      if (!draftDirty()) return;
      const first = isFirstSetup();
      const draft = getDraft();
      const total = [0, 1, 2, 3, 4, 5, 6].reduce((a, i) => a + draft[i].length, 0);
      const eff = addDays(todayKey(), 1);
      confirmModal({
        title: first ? 'Activate your schedule?' : 'Commit this plan?',
        body: first
          ? `${plural(total, 'block')} across your week go live <b>right now</b>. Blocks whose check-in window already closed today are skipped. From then on, every block is a promise.`
          : `${plural(total, 'block')} across your week. The new plan locks in on <b>${fmtDateLong(eff)}</b>. Today's schedule doesn't change.`,
        ok: first ? 'Activate' : 'Commit',
        onOk: () => {
          if (isFirstSetup()) {
            state.schedule.active = clone(draft);
            const t = todayKey(), d = state.days[t];
            if (d && d.blocks.length === 0) { delete state.days[t]; ensureDay(t, true); }
            toast('Schedule is live. The clock is in charge now.', 'good');
          } else {
            state.schedule.pending = { effective: eff, days: clone(draft), committedAt: Date.now() };
            toast(`Committed. Locks in on ${fmtDateShort(eff)}.`, 'good');
          }
          state.draft = null; ui.editId = null;
          evaluate(); save(); render();
        },
      });
    },
    'test-alert': () => {
      if (state.settings.notify && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Schedula test', { body: 'Alerts are working.' }); } catch (e) { /* ignore */ }
      }
      const was = state.settings.sound; state.settings.sound = true; chime('alert'); state.settings.sound = was;
      toast('Test alert sent.');
    },
    export: () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `schedula-backup-${todayKey()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast('Backup exported.', 'good');
    },
    reset: () => {
      openModal(`<h2>Reset everything?</h2><p class="muted">${syncUser()
        ? 'This signs this device out and erases its data. <b>Your account and other devices are not affected</b> — sign in again to get everything back.'
        : 'This permanently erases your schedule, habits, and entire history. Export a backup first if you might want it.'} Type <b>RESET</b> to confirm.</p>
        <form data-form="reset" autocomplete="off"><input type="text" name="confirm" placeholder="RESET">
        <div class="modal-actions"><button class="btn ghost" type="button" data-action="close-modal">Cancel</button><button class="btn danger" type="submit">Erase all data</button></div></form>`, { kind: 'reset' });
    },
  };

  function openCapture() {
    openModal(`<p class="eyebrow">Quick capture</p><h2>Get it out of your head</h2>
      <p class="muted">It lands in your inbox. Back to work.</p>
      <form data-form="capture" class="inline-add" autocomplete="off">
        <input type="text" name="text" maxlength="160" placeholder="Task, idea, reminder…" aria-label="Capture to inbox">
        <button class="btn primary" type="submit">Capture</button></form>`, { kind: 'capture' });
  }

  function openShutdown() {
    const t = todayKey(), st = dayStats(t), r = state.reviews[t] || {};
    const next = state.priorities[addDays(t, 1)] || [];
    const undone = (state.priorities[t] || []).filter(p => !p.done);
    openModal(`
      <button class="btn icon ghost close-x" data-action="close-modal" aria-label="Close">${ICON.x}</button>
      <p class="eyebrow">🌙 Shutdown ritual</p>
      <h2>Close out ${fmtDateShort(t)}</h2>
      <p class="muted">Today: ${pct(st.score)} · ${st.bDone}/${st.bTotal} blocks · ${st.hDone}/${st.hTotal} habits · ${st.pDone}/${st.pTotal} priorities${undone.length ? ` — ${plural(undone.length, 'unfinished priority', 'unfinished priorities')} will roll into tomorrow's inbox` : ''}.</p>
      <form data-form="review" class="stack" style="gap:16px" autocomplete="off">
        <div><span class="f" style="display:block;font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:8px">How was today? (1–10)</span>
          <div class="daychips">${Array.from({ length: 10 }, (_, i) => i + 1).map(v => `<label class="daychip"><input type="radio" name="rating" value="${v}" ${r.rating === v ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div></div>
        <label class="f">Wins — what went well?<textarea name="wins" maxlength="500" style="min-height:70px" placeholder="Shipped the landing page. Hit every morning block.">${esc(r.wins || '')}</textarea></label>
        <label class="f">One lesson for tomorrow<input type="text" name="lesson" maxlength="200" value="${esc(r.lesson || '')}" placeholder="Phone stays in the other room during deep work."></label>
        <fieldset style="grid-template-columns:1fr"><legend>Tomorrow's top 3 — ${fmtDateShort(addDays(t, 1))}</legend>
          ${[0, 1, 2].map(i => `<input type="text" name="next" maxlength="100" value="${esc(next[i] ? next[i].text : '')}" placeholder="Priority ${i + 1}" aria-label="Tomorrow priority ${i + 1}">`).join('')}
        </fieldset>
        <div class="modal-actions" style="margin-top:0"><button class="btn ghost" type="button" data-action="close-modal">Cancel</button><button class="btn primary" type="submit">Close the day</button></div>
      </form>`, { kind: 'shutdown', cls: 'wide' });
  }

  const FORMS = {
    auth: f => {
      const fd = new FormData(f);
      const mode = fd.get('mode'), email = String(fd.get('email') || '').trim(), pw = String(fd.get('password') || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authError('Enter a valid email address.'); return; }
      if (pw.length < 6) { authError('Password must be at least 6 characters.'); return; }
      if (mode === 'signup') {
        if (pw !== String(fd.get('confirm') || '')) { authError("Passwords don't match."); return; }
        runAuth(() => SYNC().signUp(email, pw), 'Account created — this device is now syncing.');
      } else {
        runAuth(() => SYNC().signIn(email, pw), 'Signed in — syncing.');
      }
    },
    intention: f => {
      const fd = new FormData(f);
      const text = String(fd.get('text') || '').trim();
      const d = state.days[todayKey()];
      const b = d && d.blocks.find(x => x.id === fd.get('id'));
      if (!b || b.status !== 'done') return;
      if (!text) { toast('Write one concrete outcome for this block.', 'bad'); return; }
      b.intention = text;
      save(); refresh();
    },
    priority: f => {
      const text = String(new FormData(f).get('text') || '').trim();
      const t = todayKey(), pr = state.priorities[t] || (state.priorities[t] = []);
      if (!text) { toast('Write the priority first.', 'bad'); return; }
      if (pr.length >= 3) { toast('Three priorities max. Focus is saying no.', 'bad'); return; }
      if (pr.some(p => p.text.toLowerCase() === text.toLowerCase())) { toast('That priority is already on the list.', 'bad'); return; }
      pr.push({ id: uid(), text, done: false, at: Date.now() });
      save(); render();
      if (pr.length < 3) { const i = $('form[data-form=priority] input'); if (i) i.focus(); }
      if (pr.length === 3) toast('Top 3 locked in. Make them happen.', 'good');
    },
    capture: f => {
      const text = String(new FormData(f).get('text') || '').trim();
      if (!text) { toast('Type something to capture.', 'bad'); return; }
      state.inbox.unshift({ id: uid(), text, created: todayKey() });
      save();
      const inModal = modalKind === 'capture';
      if (inModal) closeModal();
      render();
      toast('Captured to inbox.', 'good');
      if (!inModal) { const i = $('form[data-form=capture] input'); if (i) i.focus(); }
    },
    review: f => {
      const fd = new FormData(f);
      const rating = Number(fd.get('rating'));
      if (!Number.isInteger(rating) || rating < 1 || rating > 10) { toast('Rate your day from 1 to 10.', 'bad'); return; }
      const t = todayKey(), tm = addDays(t, 1);
      const next = fd.getAll('next').map(s => String(s).trim()).filter(Boolean).slice(0, 3);
      state.reviews[t] = { rating, wins: String(fd.get('wins') || '').trim(), lesson: String(fd.get('lesson') || '').trim(), at: Date.now() };
      state.priorities[tm] = next.map(text => ({ id: uid(), text, done: false, at: 0 }));
      save(); closeModal(); render();
      toast(next.length ? `Day closed. Tomorrow's top ${next.length} ${next.length === 1 ? 'is' : 'are'} waiting.` : 'Day closed. Rest well.', 'good');
    },
    excuse: f => {
      const reason = String(new FormData(f).get('reason') || '').trim();
      if (reason.length < EXCUSE_MIN) { toast(`Write at least ${EXCUSE_MIN} characters.`, 'bad'); return; }
      const misses = unackedMisses();
      if (misses.length) {
        misses.forEach(({ b }) => { b.acked = true; });
        state.excuses.push({
          id: uid(), at: Date.now(), date: misses[misses.length - 1].k, reason,
          items: misses.map(({ k, b }) => ({ date: k, start: b.start, title: b.title })),
        });
      }
      save(); closeModal(true); render();
      toast('Logged. Now make the next one count.');
    },
    'habit-add': f => {
      const fd = new FormData(f);
      const name = String(fd.get('name') || '').trim();
      const emoji = String(fd.get('emoji') || '').trim() || '✨';
      if (!name) { toast('Give the habit a name.', 'bad'); return; }
      if (state.habits.some(h => !h.archived && h.name.toLowerCase() === name.toLowerCase())) { toast('You already track that habit.', 'bad'); return; }
      state.habits.push({ id: uid(), name, emoji, created: todayKey(), archived: null });
      save(); render(); toast(`Added "${name}". It counts from today.`, 'good');
      const i = $('form[data-form=habit-add] input[name=name]'); if (i) i.focus();
    },
    'habit-edit': f => {
      const fd = new FormData(f);
      const h = state.habits.find(x => x.id === fd.get('id'));
      const name = String(fd.get('name') || '').trim();
      if (!h || !name) { toast('Name is required.', 'bad'); return; }
      h.name = name; h.emoji = String(fd.get('emoji') || '').trim() || h.emoji;
      save(); closeModal(); render();
    },
    block: f => {
      const fd = new FormData(f);
      const start = String(fd.get('start') || ''), end = String(fd.get('end') || '');
      const title = String(fd.get('title') || '').trim();
      const emoji = String(fd.get('emoji') || '').trim() || '•';
      const cat = CATS[fd.get('cat')] ? String(fd.get('cat')) : 'focus';
      if (!isHM(start) || !isHM(end)) { toast('Enter valid start and end times.', 'bad'); return; }
      if (!title) { toast('Give the block a name.', 'bad'); return; }
      const s = toMin(start), e = toMin(end);
      if (e <= s) { toast("End must be after start. Blocks can't cross midnight — split them.", 'bad'); return; }
      if (e - s < 5) { toast('Blocks must be at least 5 minutes long.', 'bad'); return; }
      const list = getDraft()[ui.planDay];
      const clash = list.find(b => b.id !== ui.editId && s < toMin(b.end) && toMin(b.start) < e);
      if (clash) { toast(`Overlaps "${clash.title}" (${clash.start}–${clash.end}).`, 'bad'); return; }
      if (ui.editId) {
        const b = list.find(x => x.id === ui.editId);
        if (b) Object.assign(b, { start, end, title, emoji, cat });
        ui.editId = null;
      } else {
        list.push({ id: uid(), start, end, title, emoji, cat });
      }
      sortBlocks(list);
      save(); render();
      const i = $('form[data-form=block] input[name=title]'); if (i) i.focus();
    },
    copy: f => {
      const to = new FormData(f).getAll('to').map(Number).filter(i => i !== ui.planDay);
      if (!to.length) { toast('Pick at least one day to copy to.', 'bad'); return; }
      const draft = getDraft(), src = draft[ui.planDay];
      const overwrite = to.filter(i => draft[i].length);
      const doCopy = () => {
        to.forEach(i => { draft[i] = src.map(b => ({ ...b, id: uid() })); });
        save(); render(); toast(`Copied to ${to.map(i => DOW_SHORT[i]).join(', ')}.`, 'good');
      };
      if (overwrite.length) confirmModal({ title: 'Replace existing blocks?', body: `${overwrite.map(i => DOW_LONG[i]).join(', ')} already ${overwrite.length === 1 ? 'has' : 'have'} blocks. They will be replaced.`, ok: 'Replace', danger: true, onOk: doCopy });
      else doCopy();
    },
    wizard: f => {
      const fd = new FormData(f);
      const o = {
        wake: String(fd.get('wake')), sleep: String(fd.get('sleep')),
        workStart: String(fd.get('workStart')), workEnd: String(fd.get('workEnd')),
        gymTime: String(fd.get('gymTime')), projTime: String(fd.get('projTime')),
        gymDur: Number(fd.get('gymDur')), projDur: Number(fd.get('projDur')), readMin: Number(fd.get('readMin')),
        workDays: new Set(fd.getAll('workDays').map(Number)), gymDays: new Set(fd.getAll('gymDays').map(Number)),
      };
      if (![o.wake, o.sleep, o.workStart, o.workEnd, o.gymTime, o.projTime].every(isHM)) { toast('Fill in every time field.', 'bad'); return; }
      if (toMin(o.sleep) - toMin(o.wake) < 240) { toast('Lights out must be at least 4 hours after waking (same day, before midnight).', 'bad'); return; }
      if (o.workDays.size && toMin(o.workEnd) <= toMin(o.workStart)) { toast('Work must end after it starts.', 'bad'); return; }
      const { week, dropped, count } = generate(o);
      state.draft = week; ui.editId = null;
      save(); closeModal();
      if (ui.view !== 'plan') go('plan'); else render();
      toast(`Draft ready: ${plural(count, 'block')}${dropped ? ` (${dropped} skipped for overlapping or falling outside your day)` : ''}. Review, then commit.`, 'good');
    },
    settings: async f => {
      const fd = new FormData(f);
      const early = Number(fd.get('early')), grace = Number(fd.get('grace'));
      if (!Number.isInteger(early) || early < 0 || early > 30) { toast('Early check-in must be a whole number from 0 to 30.', 'bad'); return; }
      if (!Number.isInteger(grace) || grace < 1 || grace > 60) { toast('Grace period must be a whole number from 1 to 60.', 'bad'); return; }
      const pomoFocus = Number(fd.get('pomoFocus')), pomoBreak = Number(fd.get('pomoBreak'));
      if (!Number.isInteger(pomoFocus) || pomoFocus < 5 || pomoFocus > 90) { toast('Pomodoro focus must be a whole number from 5 to 90.', 'bad'); return; }
      if (!Number.isInteger(pomoBreak) || pomoBreak < 1 || pomoBreak > 30) { toast('Pomodoro break must be a whole number from 1 to 30.', 'bad'); return; }
      let notify = fd.get('notify') === 'on';
      if (notify && 'Notification' in window && Notification.permission !== 'granted') {
        try { notify = (await Notification.requestPermission()) === 'granted'; } catch (e) { notify = false; }
        if (!notify) toast('Notifications were not allowed.', 'bad');
      }
      const rulesChanged = early !== state.settings.early || grace !== state.settings.grace;
      Object.assign(state.settings, { name: String(fd.get('name') || '').trim(), early, grace, pomoFocus, pomoBreak, sound: fd.get('sound') === 'on', notify });
      save(); render();
      toast(rulesChanged ? 'Saved. New window rules apply from tomorrow.' : 'Settings saved.', 'good');
    },
    reset: async f => {
      if (String(new FormData(f).get('confirm') || '').trim() !== 'RESET') { toast('Type RESET to confirm.', 'bad'); return; }
      // Disconnect first so the reset can never upload deletions to the account.
      if (syncUser() && SYNC().forgetDevice) {
        try { await SYNC().forgetDevice(); } catch (e) { toast('Could not sign out — reset cancelled to protect your account data.', 'bad'); return; }
      }
      state = defaultState();
      closeModal(true);
      ui.editId = null; fired.clear();
      evaluate(); save(); go('today');
      toast('Everything was reset. Fresh start.');
    },
  };

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    if (e.target.classList && e.target.classList.contains('overlay')) { closeModal(); return; }
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = ACTIONS[el.dataset.action];
    if (fn) { e.preventDefault(); fn(el); }
  });

  document.addEventListener('submit', e => {
    const f = e.target, fn = FORMS[f.dataset.form];
    if (!fn) return;
    e.preventDefault();
    fn(f);
  });

  document.addEventListener('input', e => {
    if (e.target.name === 'reason') {
      const n = e.target.value.trim().length;
      const c = $('#reasonCounter'), b = $('#reasonBtn');
      if (c) { c.textContent = n >= EXCUSE_MIN ? `${n} characters ✓` : `${n} / ${EXCUSE_MIN} min`; c.classList.toggle('ok', n >= EXCUSE_MIN); }
      if (b) b.disabled = n < EXCUSE_MIN;
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id !== 'importFile') return;
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let obj;
      try { obj = JSON.parse(String(reader.result)); } catch (err) { toast('That file is not valid JSON.', 'bad'); return; }
      if (!obj || typeof obj !== 'object' || !obj.schedule || !obj.days || !Array.isArray(obj.habits)) { toast("That file isn't a Schedula backup.", 'bad'); return; }
      confirmModal({
        title: 'Replace all data with this backup?',
        body: `Your current data is overwritten by <b>${esc(file.name)}</b>.${syncUser() ? ' Because you are signed in, <b>your account and other devices will be replaced too</b>.' : ''}`,
        ok: 'Import', danger: true,
        onOk: () => { state = migrate(obj); ui.editId = null; fired.clear(); evaluate(); save(); render(); toast('Backup imported.', 'good'); },
      });
    };
    reader.readAsText(file);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modalKind) { closeModal(); return; }
    if (e.target.closest && e.target.closest('label.btn') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); const i = $('#importFile'); if (i) i.click(); return; }
    if (modalKind || isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'f' || e.key === 'F') { ACTIONS.focus(); return; }
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); openCapture(); return; }
    if ((e.key === 'q' || e.key === 'Q') && ui.view === 'today') { ACTIONS['quote-next'](); return; }
    const map = { 1: 'today', 2: 'habits', 3: 'plan', 4: 'stats', 5: 'settings' };
    if (map[e.key]) go(map[e.key]);
  });

  /** '#capture' (used by the installed app's shortcut) opens quick capture on Today. */
  function handleCaptureHash() {
    if (location.hash !== '#capture') return false;
    history.replaceState(null, '', '#today');
    ui.view = 'today';
    render();
    if (modalKind !== 'excuse') openCapture();
    return true;
  }

  window.addEventListener('hashchange', () => {
    if (handleCaptureHash()) return;
    ui.view = viewFromHash(); ui.editId = null; render(); window.scrollTo(0, 0);
  });

  window.addEventListener('storage', e => {
    if (e.key !== STORE_KEY || !e.newValue) return;
    try { state = migrate(JSON.parse(e.newValue)); } catch (err) { return; }
    if (!isTyping()) render();
  });

  /* ---------- installable app / offline ---------- */
  const pwa = {
    installEvent: null,  // deferred beforeinstallprompt
    waiting: null,       // a new service worker waiting to take over
    offlineReady: false,
    persisted: null,     // navigator.storage.persist() result
  };
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function showUpdateBar() {
    if ($('#updateBar')) return;
    const el = document.createElement('div');
    el.id = 'updateBar';
    el.className = 'toast update-bar';
    el.innerHTML = `<span>A new version of Schedula is ready.</span><button class="btn primary sm" data-action="apply-update">Update</button>`;
    $('#toastRoot').appendChild(el);
  }

  function setupPWA() {
    const net = () => { document.body.classList.toggle('is-offline', !navigator.onLine); };
    window.addEventListener('online', () => { net(); toast('Back online.'); });
    window.addEventListener('offline', () => { net(); toast('Offline — everything keeps working.'); });
    net();

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      pwa.installEvent = e;
      if (!isTyping()) render();
    });
    window.addEventListener('appinstalled', () => {
      pwa.installEvent = null;
      toast('Schedula is installed. Open it from your apps anytime — even offline.', 'good');
      render();
    });

    // Ask the browser not to evict our localStorage/cache under storage pressure.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persisted()
        .then(p => p || navigator.storage.persist())
        .then(p => { pwa.persisted = p; })
        .catch(() => { /* not supported */ });
    }

    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').then(reg => {
      const track = sw => {
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed') {
            if (navigator.serviceWorker.controller) { pwa.waiting = sw; showUpdateBar(); }
            else { pwa.offlineReady = true; toast('Ready to work offline.', 'good'); if (ui.view === 'settings') render(); }
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) { pwa.waiting = reg.waiting; showUpdateBar(); }
      track(reg.installing);
      reg.addEventListener('updatefound', () => track(reg.installing));
      if (navigator.serviceWorker.controller) pwa.offlineReady = true;
      // Check for a new version whenever the app comes back to the foreground.
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => { /* registration failed — the app still works online */ });

    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !pwa.waiting) return;
      reloading = true;
      location.reload();
    });
  }

  function appCardHTML() {
    const standalone = isStandalone();
    let status, action = '';
    if (location.protocol === 'file:') {
      status = 'Opened as a file. To install and use offline, run <code>start.bat</code> (or <code>python -m http.server 5178</code>) and open <b>http://localhost:5178</b>.';
    } else if (standalone) {
      status = '✅ Running as an installed app.';
    } else if (pwa.installEvent) {
      status = 'Install Schedula as an app: its own window, a desktop/home-screen icon, and full offline use.';
      action = `<button class="btn primary" data-action="install">${ICON.download} Install app</button>`;
    } else if (isIOS()) {
      status = 'On iPhone/iPad: tap <b>Share</b> → <b>Add to Home Screen</b>.';
    } else {
      status = 'Use your browser\'s menu → <b>Install Schedula</b> (or the install icon in the address bar). Already installed? Open it from your apps.';
    }
    const offline = location.protocol === 'file:' ? '—' : (pwa.offlineReady || navigator.serviceWorker && navigator.serviceWorker.controller) ? '✅ Ready' : '⏳ Preparing…';
    return `<div class="card">
      <div class="card-head"><h2>App</h2></div>
      <p class="muted small" style="margin-bottom:14px">${status}</p>
      ${action}
      <div class="set-row"><div><b>Offline mode</b><div class="d">All pages, quotes and your data work without internet.</div></div><span class="mono small">${offline}</span></div>
      <div class="set-row"><div><b>Protected storage</b><div class="d">Asks the browser not to auto-clear your data.</div></div><span class="mono small">${pwa.persisted === null ? '—' : pwa.persisted ? '✅ On' : 'Not granted'}</span></div>
    </div>`;
  }

  /* ---------- clock ---------- */
  function tick() {
    const evalChanged = evaluate();
    const changed = pomoTick() || evalChanged;
    scanNotifications();
    const sig = focusSig();
    const minute = Math.floor(Date.now() / 60000);
    const shifted = changed || sig !== ui.sig || minute !== ui.minute;
    if (ui.view === 'today' && shifted && !isTyping()) render();
    else if ((ui.view === 'habits' || ui.view === 'stats') && changed && !isTyping()) render();
    else if (shifted) { ui.sig = sig; ui.minute = minute; }
    if (modalKind === 'focus' && shifted) renderFocus();
    updateLive();
    checkExcuses();
  }

  evaluate();
  save();
  setupPWA();
  render();
  checkExcuses();
  handleCaptureHash();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
})();
