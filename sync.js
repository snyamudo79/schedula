/* ==========================================================================
   Schedula sync — optional accounts + phone/desktop sync.

   Design
   - The app state is split into small "units" (one per habit, per day, per
     inbox item, settings, schedule, …). Each unit is one Firestore document:
       users/{uid}/items/{unitKey} = { k, v: JSON, t: editTime, dev, st: serverTime }
   - Every local save is diffed against a "shadow" (hash + edit time per unit),
     so only changed units are uploaded. Offline edits stay queued.
   - Remote changes stream in live. Conflicts: newest edit wins per unit,
     except a day's schedule, which is merged block-by-block (a check-in always
     beats "missed"; acknowledgements, ratings and intentions are kept).
   - The pure core (no Firebase) is exported for tools/sync-test.js.
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---------- pure helpers ---------- */
  function stableStringify(v) {
    if (v === null || typeof v !== 'object') { const s = JSON.stringify(v); return s === undefined ? 'null' : s; }
    if (Array.isArray(v)) return `[${v.map(x => (x === undefined || typeof x === 'function') ? 'null' : stableStringify(x)).join(',')}]`;
    return `{${Object.keys(v).sort()
      .filter(k => v[k] !== undefined && typeof v[k] !== 'function')
      .map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  function hashStr(str) { // cyrb53
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }
  const NULL_H = hashStr('null');
  const hashVal = v => hashStr(stableStringify(v));
  const weekEmpty = w => !w || [0, 1, 2, 3, 4, 5, 6].every(i => !w[i] || !w[i].length);

  /* ---------- state <-> units ---------- */
  function toUnits(s) {
    const u = {};
    u.meta = { createdAt: s.createdAt, habitOrder: (s.habits || []).map(h => h.id), inboxOrder: (s.inbox || []).map(i => i.id) };
    if (s.settings) u.settings = s.settings;
    if (s.schedule) u.schedule = s.schedule;
    if (s.draft) u.draft = s.draft;
    if (s.quotes) u.quotes = s.quotes;
    if (s.pomo) u.pomo = s.pomo;
    for (const h of s.habits || []) u[`habit:${h.id}`] = h;
    for (const i of s.inbox || []) u[`inbox:${i.id}`] = i;
    for (const e of s.excuses || []) if (e && e.id) u[`excuse:${e.id}`] = e;
    for (const k in s.days || {}) u[`day:${k}`] = s.days[k];
    for (const k in s.habitLog || {}) if (Object.keys(s.habitLog[k] || {}).length) u[`hlog:${k}`] = s.habitLog[k];
    for (const k in s.priorities || {}) if ((s.priorities[k] || []).length) u[`prio:${k}`] = s.priorities[k];
    for (const k in s.pomos || {}) u[`pomos:${k}`] = s.pomos[k];
    for (const k in s.reviews || {}) u[`review:${k}`] = s.reviews[k];
    return u;
  }

  function ordered(map, ids, cmp) {
    const out = [], seen = new Set();
    for (const id of ids || []) if (map[id] && !seen.has(id)) { out.push(map[id]); seen.add(id); }
    return out.concat(Object.keys(map).filter(id => !seen.has(id)).map(id => map[id]).sort(cmp));
  }

  /** Rebuild app state from units. `adopt` = this device takes the account's state as-is. */
  function fromUnits(u, base, adopt) {
    const meta = u.meta || {};
    const s = {
      version: 1,
      createdAt: meta.createdAt || base.createdAt,
      lastEval: adopt ? null : base.lastEval,
      settings: u.settings || base.settings,
      schedule: u.schedule || base.schedule,
      draft: u.draft || null,
      quotes: u.quotes || base.quotes,
      pomo: u.pomo || null,
      habits: [], habitLog: {}, days: {}, excuses: [], priorities: {}, inbox: [], pomos: {}, reviews: {},
    };
    const habits = {}, inbox = {};
    for (const k in u) {
      const i = k.indexOf(':');
      if (i < 0 || u[k] == null) continue;
      const type = k.slice(0, i), id = k.slice(i + 1), v = u[k];
      if (type === 'habit') habits[id] = v;
      else if (type === 'inbox') inbox[id] = v;
      else if (type === 'excuse') s.excuses.push(v);
      else if (type === 'day') s.days[id] = v;
      else if (type === 'hlog') s.habitLog[id] = v;
      else if (type === 'prio') s.priorities[id] = v;
      else if (type === 'pomos') s.pomos[id] = v;
      else if (type === 'review') s.reviews[id] = v;
    }
    s.habits = ordered(habits, meta.habitOrder, (a, b) => String(a.created || '').localeCompare(String(b.created || '')) || String(a.id).localeCompare(String(b.id)));
    s.inbox = ordered(inbox, meta.inboxOrder, (a, b) => String(b.created || '').localeCompare(String(a.created || '')) || String(a.id).localeCompare(String(b.id)));
    s.excuses.sort((a, b) => (a.at || 0) - (b.at || 0));
    return s;
  }

  /* ---------- merging ---------- */
  const RANK = { done: 3, missed: 2, pending: 1 };
  function mergeBlock(x, y) {
    if (!y) return x;
    if (!x) return y;
    let win;
    const rx = RANK[x.status] || 0, ry = RANK[y.status] || 0;
    if (rx !== ry) win = rx > ry ? x : y;                                   // a check-in beats "missed" beats "pending"
    else if ((x.doneTs || 0) !== (y.doneTs || 0)) win = (x.doneTs || Infinity) < (y.doneTs || Infinity) ? x : y; // earliest check-in
    else win = stableStringify(x) <= stableStringify(y) ? x : y;           // deterministic tie-break
    const out = { ...win };
    delete out.acked; delete out.rating; delete out.intention;
    if (x.acked || y.acked) out.acked = true;
    const rating = win.rating || x.rating || y.rating;
    if (rating) out.rating = rating;
    const intention = win.intention || x.intention || y.intention;
    if (intention) out.intention = intention;
    return out;
  }
  /** Merge two versions of one day. Commutative, so devices always converge. */
  function mergeDay(a, b) {
    if (!a) return b;
    if (!b) return a;
    const key = d => [d.snapAt == null ? Number.MAX_SAFE_INTEGER : d.snapAt, (d.blocks || []).map(x => x.id).join(',')];
    let base;
    if (!(a.blocks || []).length) base = b;
    else if (!(b.blocks || []).length) base = a;
    else {
      const ka = key(a), kb = key(b);
      base = ka[0] !== kb[0] ? (ka[0] < kb[0] ? a : b) : (ka[1] <= kb[1] ? a : b); // the earlier snapshot defines the day's blocks
    }
    const other = base === a ? b : a;
    const om = new Map((other.blocks || []).map(x => [x.id, x]));
    const out = { ...other, ...base, blocks: (base.blocks || []).map(x => mergeBlock(x, om.get(x.id))) };
    delete out.final;
    if (a.final || b.final) out.final = true;
    return out;
  }

  function meaningful(s) {
    if (!s) return false;
    const sc = s.schedule || {};
    return !weekEmpty(sc.active) || !!(sc.pending && !weekEmpty(sc.pending.days))
      || Object.values(s.days || {}).some(d => d && d.blocks && d.blocks.length)
      || Object.values(s.habitLog || {}).some(m => m && Object.keys(m).length)
      || (s.inbox || []).length > 0
      || Object.values(s.priorities || {}).some(p => p && p.length)
      || Object.keys(s.reviews || {}).length > 0;
  }

  /** First sign-in on a device that already has data, user chose "merge". Remote wins ties. */
  function mergeForLink(local, remote) {
    const out = { ...remote };
    const norm = n => String(n || '').trim().toLowerCase();
    const byName = {};
    for (const k in remote) if (k.startsWith('habit:') && remote[k] && !remote[k].archived) byName[norm(remote[k].name)] = remote[k].id;
    const idMap = {};
    for (const k in local) {
      if (!k.startsWith('habit:')) continue;
      const h = local[k], rid = byName[norm(h.name)];
      if (rid && rid !== h.id && !h.archived) {
        idMap[h.id] = rid;
        const rk = `habit:${rid}`;
        if (h.created && out[rk] && (!out[rk].created || h.created < out[rk].created)) out[rk] = { ...out[rk], created: h.created };
      } else if (!out[k]) out[k] = h;
    }
    for (const k in local) {
      const v = local[k], r = remote[k];
      if (k.startsWith('habit:')) continue;
      if (k.startsWith('hlog:')) {
        const m = { ...(r || {}) };
        for (const id in v) if (v[id]) m[idMap[id] || id] = true;
        out[k] = m;
      } else if (k.startsWith('day:')) out[k] = r ? mergeDay(v, r) : v;
      else if (k.startsWith('pomos:')) out[k] = Math.max(Number(v) || 0, Number(r) || 0);
      else if (k.startsWith('prio:')) out[k] = r && r.length ? r : v;
      else if (k === 'schedule') out[k] = (!r || (weekEmpty(r.active) && !r.pending)) ? v : r;
      else if (k === 'meta') {
        out[k] = {
          createdAt: [v.createdAt, r && r.createdAt].filter(Boolean).sort()[0],
          habitOrder: [...((r && r.habitOrder) || []), ...(v.habitOrder || []).filter(id => !idMap[id])],
          inboxOrder: [...((r && r.inboxOrder) || []), ...(v.inboxOrder || [])],
        };
      } else if (!(k in out)) out[k] = v;
    }
    return out;
  }

  /* ---------- engine ---------- */
  function createEngine(o) {
    const now = o.now || (() => Date.now());
    const debounce = o.debounceMs == null ? 700 : o.debounceMs;
    let uid = null, shadow = null, unsub = null, timer = null;
    let stopped = true, linking = false, linkBuf = null, late = [], writing = false, again = false;
    const status = (s, x) => { if (o.onStatus) o.onStatus(s, x); };
    const persist = () => o.saveShadow(shadow);

    function start(u) {
      stop();
      stopped = false;
      uid = u;
      const sh = o.loadShadow();
      const known = sh && sh.uid === u && sh.linked;
      shadow = known ? sh : { uid: u, units: {}, lastPull: 0, unacked: [], linked: false };
      shadow.unacked = shadow.unacked || [];
      linking = !known;
      linkBuf = new Map();
      late = [];
      status('connecting');
      unsub = o.backend.subscribe(u, linking ? 0 : (shadow.lastPull || 0), onBatch, err => status('error', err));
      if (!linking) { diff(); schedule(0); }
    }

    function stop() {
      stopped = true;
      if (unsub) { try { unsub(); } catch (e) { /* ignore */ } unsub = null; }
      clearTimeout(timer); timer = null;
    }

    function onBatch(changes, meta) {
      if (stopped) return;
      if (linking === true) {
        for (const c of changes) linkBuf.set(c.k, c);
        if (meta && meta.fromCache) return;   // wait for the server's answer before deciding anything
        linking = 'busy';
        link([...linkBuf.values()]).catch(e => status('error', e));
        return;
      }
      if (linking === 'busy') { late.push(...changes); return; }
      if (!changes.length) { if (!(meta && meta.fromCache) && !shadow.unacked.length && !writing) status('synced'); return; }
      applyRemote(changes);
      if (!shadow.unacked.length && !writing) status('synced', { at: now() });
    }

    async function link(all) {
      const raw = {}, remote = {};
      for (const c of all) raw[c.k] = c;
      for (const k in raw) if (raw[k].v != null) { try { remote[k] = JSON.parse(raw[k].v); } catch (e) { /* skip corrupt */ } }
      const st = o.getState();
      const local = toUnits(st);
      let mode;
      if (!Object.keys(remote).length) mode = 'upload';
      else if (!meaningful(st)) mode = 'account';
      else { status('choose'); mode = await o.chooseLinkMode(); }
      if (stopped) return;
      if (mode !== 'account' && mode !== 'merge' && mode !== 'upload') mode = 'account';
      const units = mode === 'upload' ? local : mode === 'account' ? remote : mergeForLink(local, remote);
      shadow.units = {};
      let lp = 0;
      for (const k in raw) {
        shadow.units[k] = { h: raw[k].v == null ? NULL_H : hashStr(raw[k].v), t: raw[k].t || 0 };
        lp = Math.max(lp, raw[k].st || 0);
      }
      shadow.lastPull = lp;
      shadow.unacked = [];
      shadow.linked = true;
      linking = false;
      persist();
      o.applyState(fromUnits(units, st, mode === 'account')); // app saves → localChanged() → diff
      diff();
      schedule(0);
      if (late.length) { const l = late; late = []; applyRemote(l); }
      status(shadow.unacked.length ? 'syncing' : 'synced', { at: now(), mode });
    }

    function applyRemote(changes) {
      const st = o.getState();
      const cur = toUnits(st);
      let changed = false;
      for (const c of changes) {
        if (c.st > (shadow.lastPull || 0)) shadow.lastPull = c.st;
        const sh = shadow.units[c.k];
        const rh = c.v == null ? NULL_H : hashStr(c.v);
        if (sh && sh.h === rh) { if ((c.t || 0) > sh.t) sh.t = c.t; continue; } // same content (incl. our own echo)
        let rv;
        if (c.v != null) { try { rv = JSON.parse(c.v); } catch (e) { continue; } }
        if (c.k.startsWith('day:') && rv && cur[c.k]) {
          cur[c.k] = mergeDay(cur[c.k], rv);          // always merge days; diff() re-uploads if we added anything
          shadow.units[c.k] = { h: rh, t: Math.max(c.t || 0, sh ? sh.t : 0) };
          changed = true;
          continue;
        }
        const remoteNewer = !sh || (c.t || 0) > sh.t || ((c.t || 0) === sh.t && String(c.dev) > String(o.deviceId));
        if (!remoteNewer) continue;                   // our newer edit wins and is (being) uploaded
        if (rv === undefined) delete cur[c.k]; else cur[c.k] = rv;
        shadow.units[c.k] = { h: rh, t: c.t || 0 };
        shadow.unacked = shadow.unacked.filter(k => k !== c.k);
        changed = true;
      }
      persist();
      if (changed) o.applyState(fromUnits(cur, st, false));
    }

    /** Compare the current state with the shadow and stamp every changed unit. */
    function diff() {
      if (stopped || linking) return false;
      const cur = toUnits(o.getState());
      const t = now();
      let any = false;
      const keys = new Set([...Object.keys(cur), ...Object.keys(shadow.units)]);
      for (const k of keys) {
        const h = k in cur ? hashVal(cur[k]) : NULL_H;
        const sh = shadow.units[k];
        if (sh ? sh.h === h : h === NULL_H) continue;
        shadow.units[k] = { h, t: Math.max(t, sh ? sh.t + 1 : 0) };
        if (!shadow.unacked.includes(k)) shadow.unacked.push(k);
        any = true;
      }
      if (any) persist();
      return any;
    }

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(flush, ms == null ? debounce : ms);
    }

    async function flush() {
      if (stopped || linking || !shadow.unacked.length) return;
      if (writing) { again = true; return; }
      writing = true;
      status('syncing');
      const cur = toUnits(o.getState());
      const keys = shadow.unacked.slice();
      const docs = keys.map(k => ({ k, v: k in cur ? stableStringify(cur[k]) : null, t: shadow.units[k].t, dev: o.deviceId }));
      try {
        await o.backend.write(uid, docs);
        const sent = new Map(docs.map(d => [d.k, d.t]));
        shadow.unacked = shadow.unacked.filter(k => !sent.has(k) || !shadow.units[k] || shadow.units[k].t !== sent.get(k));
        persist();
        if (!shadow.unacked.length) status('synced', { at: now() });
      } catch (e) {
        status('error', e);
        if (!stopped) timer = setTimeout(flush, 15000);
      } finally {
        writing = false;
        if (again && !stopped) { again = false; schedule(0); }
      }
    }

    return {
      start,
      stop,
      localChanged() { if (diff()) schedule(); },
      syncNow() { diff(); schedule(0); },
      pending: () => (shadow ? shadow.unacked.length : 0),
      get running() { return !stopped; },
    };
  }

  const core = { stableStringify, hashStr, toUnits, fromUnits, mergeDay, mergeBlock, meaningful, mergeForLink, createEngine };
  if (typeof module !== 'undefined' && module.exports) { module.exports = core; return; }

  /* ======================================================================
     Browser: Firebase Auth + Firestore
     ====================================================================== */
  const CFG = root.SCHEDULA_FIREBASE || {};
  const configured = !!(CFG.apiKey && CFG.projectId && CFG.appId);
  const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const SHADOW_KEY = 'schedula.sync.v1', DEVICE_KEY = 'schedula.device';
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  let deviceId = ls.get(DEVICE_KEY);
  if (!deviceId) { deviceId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); ls.set(DEVICE_KEY, deviceId); }

  const Sync = { configured, state: configured ? 'loading' : 'off', user: null, error: '', lastSyncAt: 0 };
  let fb = null, engine = null, initing = false;
  const emit = () => { if (root.Schedula && root.Schedula.onSyncStatus) root.Schedula.onSyncStatus(Sync); };

  const MESSAGES = {
    'auth/invalid-email': 'That email address looks wrong.',
    'auth/missing-email': 'Enter your email address.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email. Create one instead?',
    'auth/email-already-in-use': 'An account with this email already exists. Sign in instead.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/missing-password': 'Enter your password.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': "Can't reach the server. Check your connection.",
    'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
    'auth/cancelled-popup-request': 'Google sign-in was cancelled.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in the Firebase project yet.',
    'auth/unauthorized-domain': 'This website is not authorized in the Firebase project (Authentication → Settings → Authorized domains).',
    'permission-denied': 'The server refused access. Check the Firestore security rules.',
    unavailable: 'Server unreachable — changes will sync when you are back online.',
  };
  function friendly(e) {
    if (!e) return '';
    const code = e.code || '';
    return MESSAGES[code] || MESSAGES[code.replace(/^firestore\//, '')] || (e.message || String(e)).replace(/^Firebase: /, '').replace(/\s*\(auth\/[^)]+\)\.?$/, '');
  }

  function setStatus(s, x) {
    if (s === 'error') Sync.error = friendly(x);
    else if (s !== 'syncing') Sync.error = '';
    if (s === 'synced') Sync.lastSyncAt = (x && x.at) || Date.now();
    Sync.state = s;
    emit();
  }

  function firestoreBackend() {
    const { F, db } = fb;
    const col = u => F.collection(db, 'users', u, 'items');
    return {
      subscribe(u, since, onBatch, onError) {
        const q = F.query(col(u), F.where('st', '>', F.Timestamp.fromMillis(since || 0)));
        return F.onSnapshot(q, { includeMetadataChanges: true }, snap => {
          const changes = [];
          for (const ch of snap.docChanges()) {
            if (ch.type === 'removed') continue;
            const d = ch.doc.data({ serverTimestamps: 'none' });
            if (!d || !d.st || typeof d.k !== 'string') continue;
            changes.push({ k: d.k, v: typeof d.v === 'string' ? d.v : null, t: Number(d.t) || 0, dev: d.dev || '', st: d.st.toMillis() });
          }
          onBatch(changes, { fromCache: snap.metadata.fromCache });
        }, onError);
      },
      async write(u, docs) {
        for (let i = 0; i < docs.length; i += 400) {
          const batch = F.writeBatch(db);
          for (const d of docs.slice(i, i + 400)) {
            batch.set(F.doc(col(u), d.k), { k: d.k, v: d.v, t: d.t, dev: d.dev, st: F.serverTimestamp() });
          }
          await batch.commit();
        }
      },
    };
  }

  async function init() {
    if (!configured || fb || initing) return;
    initing = true;
    setStatus('loading');
    try {
      const [A, Au, F] = await Promise.all([
        import(`${SDK}firebase-app.js`), import(`${SDK}firebase-auth.js`), import(`${SDK}firebase-firestore.js`),
      ]);
      const app = A.initializeApp(CFG);
      const auth = Au.getAuth(app);
      let db;
      try { db = F.initializeFirestore(app, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
      catch (e) { db = F.getFirestore(app); }
      fb = { Au, F, auth, db };
      engine = createEngine({
        backend: firestoreBackend(),
        deviceId,
        getState: () => root.Schedula.getState(),
        applyState: s => root.Schedula.applyState(s),
        loadShadow: () => { try { return JSON.parse(ls.get(SHADOW_KEY) || 'null'); } catch (e) { return null; } },
        saveShadow: sh => ls.set(SHADOW_KEY, JSON.stringify(sh)),
        onStatus: setStatus,
        chooseLinkMode: () => root.Schedula.chooseLinkMode(),
      });
      Au.getRedirectResult(auth).catch(e => { Sync.error = friendly(e); emit(); });
      Au.onAuthStateChanged(auth, user => {
        Sync.user = user ? { uid: user.uid, email: user.email || '', name: user.displayName || '' } : null;
        if (user) engine.start(user.uid);
        else { engine.stop(); setStatus('signedout'); }
      });
    } catch (e) {
      fb = null;
      Sync.error = 'Sync could not load (offline?). Everything still works on this device.';
      setStatus('unavailable');
      root.addEventListener('online', () => { if (!fb) init(); }, { once: true });
    } finally {
      initing = false;
    }
  }

  const need = () => { if (!fb) throw Object.assign(new Error('Sync is still loading — try again in a moment.'), { code: '' }); };
  Object.assign(Sync, {
    init,
    friendly,
    async signUp(email, pw) { need(); await fb.Au.createUserWithEmailAndPassword(fb.auth, email, pw); },
    async signIn(email, pw) { need(); await fb.Au.signInWithEmailAndPassword(fb.auth, email, pw); },
    async google() {
      need();
      const p = new fb.Au.GoogleAuthProvider();
      p.setCustomParameters({ prompt: 'select_account' });
      try { await fb.Au.signInWithPopup(fb.auth, p); }
      catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) await fb.Au.signInWithRedirect(fb.auth, p);
        else throw e;
      }
    },
    async resetPassword(email) { need(); await fb.Au.sendPasswordResetEmail(fb.auth, email); },
    async signOut() { if (engine) engine.stop(); if (fb) await fb.Au.signOut(fb.auth); },
    /** Stop syncing on this device and forget its link to the account (used by "Reset everything"). */
    async forgetDevice() { await Sync.signOut(); ls.del(SHADOW_KEY); },
    syncNow() { if (engine && engine.running) engine.syncNow(); },
    localChanged() { if (engine && engine.running) engine.localChanged(); },
    pending() { return engine ? engine.pending() : 0; },
  });
  root.SchedulaSync = Sync;
  if (configured) init();
})(typeof window !== 'undefined' ? window : globalThis);
