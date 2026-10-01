// Simulates a server + several devices to verify Schedula's sync engine.
// Run: node tools/sync-test.js
const assert = require('assert');
const S = require('../sync.js');

/* ---------- in-memory "Firestore" ---------- */
function makeServer() {
  const docs = new Map();
  let clock = 1_000_000;
  const subs = new Set();
  let writes = 0;
  return {
    docs,
    get writes() { return writes; },
    client() {
      let online = true;
      const queue = [];
      const mySubs = new Set();
      const deliver = (sub, list) => { if (online) sub.cb(list, { fromCache: false }); };
      const commit = d => {
        const st = ++clock;
        const rec = { ...d, st };
        docs.set(d.k, rec);
        writes++;
        for (const sub of subs) if (sub.online()) sub.cb([rec], { fromCache: false });
      };
      return {
        setOnline(v) {
          online = v;
          if (v) {
            // Like a real listener reconnecting: first catch up on everything missed, then send queued writes.
            for (const sub of mySubs) {
              const list = [...docs.values()].filter(r => r.st > sub.seen);
              if (list.length) sub.cb(list, { fromCache: false });
            }
            while (queue.length) { const q = queue.shift(); q.docs.forEach(commit); q.resolve(); }
          }
        },
        subscribe(uid, since, onBatch) {
          const sub = { online: () => online, seen: since, cb: (list, meta) => { for (const r of list) sub.seen = Math.max(sub.seen, r.st); onBatch(list.map(r => ({ ...r })), meta); } };
          subs.add(sub); mySubs.add(sub);
          setImmediate(() => {
            if (!online) { sub.onBatchCache = true; onBatch([], { fromCache: true }); return; }
            sub.cb([...docs.values()].filter(r => r.st > since), { fromCache: false });
          });
          return () => { subs.delete(sub); mySubs.delete(sub); };
        },
        write(uid, list) {
          if (online) { list.forEach(commit); return Promise.resolve(); }
          return new Promise(resolve => queue.push({ docs: list, resolve }));
        },
      };
    },
  };
}

/* ---------- a device running the engine against plain state ---------- */
function makeDevice(server, name, state, linkChoice = 'account') {
  const backend = server.client();
  const dev = { name, state: JSON.parse(JSON.stringify(state)), shadow: null, backend, applied: 0 };
  dev.engine = S.createEngine({
    backend, deviceId: name, debounceMs: 0,
    getState: () => dev.state,
    applyState: s => { dev.state = JSON.parse(JSON.stringify(s)); dev.applied++; dev.engine.localChanged(); },
    loadShadow: () => dev.shadow && JSON.parse(JSON.stringify(dev.shadow)),
    saveShadow: sh => { dev.shadow = JSON.parse(JSON.stringify(sh)); },
    onStatus: () => {},
    chooseLinkMode: async () => linkChoice,
  });
  dev.edit = fn => { fn(dev.state); dev.engine.localChanged(); };
  return dev;
}
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 5)); for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const snapshot = s => S.stableStringify(S.toUnits(s));
/** Assert two devices hold identical data; on failure, show exactly which units differ. */
function assertSame(a, b, msg) {
  const ua = S.toUnits(a.state), ub = S.toUnits(b.state), diffs = [];
  for (const k of new Set([...Object.keys(ua), ...Object.keys(ub)])) {
    const x = S.stableStringify(ua[k]), y = S.stableStringify(ub[k]);
    if (x !== y) diffs.push(`${k}\n      ${a.name}: ${x}\n      ${b.name}: ${y}`);
  }
  assert.ok(!diffs.length, `${msg}:\n    ${diffs.join('\n    ')}`);
}

/* ---------- fixtures ---------- */
const week = blocks => { const w = {}; for (let i = 0; i < 7; i++) w[i] = blocks.map(b => ({ ...b })); return w; };
function baseState(over = {}) {
  return {
    version: 1, createdAt: '2026-10-01', lastEval: '2026-10-01',
    settings: { name: '', early: 5, grace: 10, sound: true, notify: false, pomoFocus: 25, pomoBreak: 5 },
    schedule: { active: week([]), pending: null }, draft: null,
    habits: [{ id: 'hA', name: 'Gym', emoji: '💪', created: '2026-10-01', archived: null }],
    habitLog: {}, days: {}, excuses: [], priorities: {}, inbox: [], pomos: {}, pomo: null, reviews: {},
    quotes: { day: null, current: null, used: [], cycle: 1 },
    ...over,
  };
}
const dayWith = (snapAt, statuses) => ({
  early: 5, grace: 10, snapAt,
  blocks: [
    { id: 'b1', start: '09:00', end: '10:00', title: 'Deep work', emoji: '💼', cat: 'focus', status: statuses[0] },
    { id: 'b2', start: '11:00', end: '12:00', title: 'Gym', emoji: '💪', cat: 'health', status: statuses[1] },
  ],
});

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}`); process.exitCode = 1; }
}

(async () => {
  console.log('pure functions');
  await test('toUnits → fromUnits round-trips the state', () => {
    const s = baseState({
      habits: [{ id: 'h1', name: 'A', emoji: 'a', created: '2026-09-01', archived: null }, { id: 'h2', name: 'B', emoji: 'b', created: '2026-09-02', archived: null }],
      inbox: [{ id: 'i2', text: 'two', created: '2026-10-01' }, { id: 'i1', text: 'one', created: '2026-09-30' }],
      days: { '2026-10-01': dayWith(1, ['done', 'pending']) }, habitLog: { '2026-10-01': { h1: true } },
      priorities: { '2026-10-01': [{ id: 'p', text: 'x', done: false, at: 1 }] }, pomos: { '2026-10-01': 2 },
      reviews: { '2026-09-30': { rating: 8, wins: 'w', lesson: '', at: 1 } }, excuses: [{ id: 'e1', at: 5, date: '2026-09-30', reason: 'r', items: [] }],
      pomo: { phase: 'focus', endsAt: 9, dur: 1 }, draft: week([]),
    });
    const back = S.fromUnits(S.toUnits(s), s, false);
    assert.strictEqual(S.stableStringify(back), S.stableStringify(s));
  });
  await test('mergeDay: a check-in beats "missed", acks/ratings kept, commutative', () => {
    const a = dayWith(100, ['done', 'missed']); a.blocks[0].doneTs = 5; a.blocks[0].doneAt = '09:01';
    const b = dayWith(100, ['missed', 'missed']); b.blocks[0].acked = true; b.blocks[1].acked = true; b.blocks[1].rating = 2;
    const ab = S.mergeDay(a, b), ba = S.mergeDay(b, a);
    assert.strictEqual(S.stableStringify(ab), S.stableStringify(ba));
    assert.strictEqual(ab.blocks[0].status, 'done');
    assert.strictEqual(ab.blocks[0].acked, true);
    assert.strictEqual(ab.blocks[1].rating, 2);
  });
  await test('mergeDay: the earlier snapshot defines the blocks; empty snapshot never wins', () => {
    const early = dayWith(1, ['pending', 'pending']);
    const lateDay = { ...dayWith(2, ['done', 'pending']), blocks: [{ ...dayWith(2, ['done'])['blocks'][0], doneTs: 3 }, { id: 'b9', start: '13:00', end: '14:00', title: 'X', status: 'pending' }] };
    const m = S.mergeDay(early, lateDay);
    assert.deepStrictEqual(m.blocks.map(b => b.id), ['b1', 'b2']);
    assert.strictEqual(m.blocks[0].status, 'done');
    const empty = { early: 5, grace: 10, snapAt: 0, blocks: [] };
    assert.deepStrictEqual(S.mergeDay(empty, early).blocks.map(b => b.id), ['b1', 'b2']);
  });

  console.log('two devices');
  await test('first device uploads; a fresh second device adopts the account', async () => {
    const server = makeServer();
    const A = makeDevice(server, 'A', baseState({ schedule: { active: week([{ id: 's1', start: '09:00', end: '10:00', title: 'Work', emoji: '💼', cat: 'focus' }]), pending: null }, habitLog: { '2026-10-01': { hA: true } } }));
    A.engine.start('u1'); await settle();
    const B = makeDevice(server, 'B', baseState({ habits: [{ id: 'seedB', name: 'Gym', emoji: '💪', created: '2026-10-01', archived: null }] }));
    B.engine.start('u1'); await settle();
    assert.strictEqual(snapshot(B.state), snapshot(A.state));
    assert.strictEqual(B.state.lastEval, null, 'adopting device re-evaluates its own day');
  });

  await test('live edits flow both ways; deletions propagate', async () => {
    const server = makeServer();
    const A = makeDevice(server, 'A', baseState({ inbox: [{ id: 'i1', text: 'call bank', created: '2026-10-01' }], habitLog: { '2026-09-30': { hA: true } } }));
    A.engine.start('u1'); await settle();
    const B = makeDevice(server, 'B', baseState()); B.engine.start('u1'); await settle();
    A.edit(s => { s.habitLog['2026-10-01'] = { hA: true }; });
    await settle();
    assert.ok(B.state.habitLog['2026-10-01'] && B.state.habitLog['2026-10-01'].hA, 'tick reached B');
    B.edit(s => { s.inbox = []; });
    await settle();
    assert.strictEqual(A.state.inbox.length, 0, 'deletion reached A');
    assert.strictEqual(snapshot(A.state), snapshot(B.state));
  });

  await test('offline on both: check-in survives "missed", other edits merge, devices converge', async () => {
    const server = makeServer();
    const t = '2026-10-01';
    const A = makeDevice(server, 'A', baseState({ days: { [t]: dayWith(10, ['pending', 'pending']) }, habitLog: { '2026-09-30': { hA: true } } }));
    A.engine.start('u1'); await settle();
    const B = makeDevice(server, 'B', baseState()); B.engine.start('u1'); await settle();
    A.backend.setOnline(false); B.backend.setOnline(false);
    A.edit(s => { const b = s.days[t].blocks[0]; b.status = 'done'; b.doneAt = '09:02'; b.doneTs = 77; });
    B.edit(s => { s.days[t].blocks[0].status = 'missed'; s.days[t].blocks[1].status = 'missed'; s.days[t].blocks[1].acked = true; });
    B.edit(s => { s.inbox.unshift({ id: 'iB', text: 'from phone', created: t }); });
    A.edit(s => { s.priorities[t] = [{ id: 'pA', text: 'ship it', done: false, at: 1 }]; });
    await settle();
    A.backend.setOnline(true); B.backend.setOnline(true);
    await settle(60);
    assertSame(A, B, 'devices converged');
    const d = A.state.days[t];
    assert.strictEqual(d.blocks[0].status, 'done');
    assert.strictEqual(d.blocks[0].doneAt, '09:02');
    assert.strictEqual(d.blocks[1].status, 'missed');
    assert.strictEqual(d.blocks[1].acked, true);
    assert.strictEqual(A.state.inbox[0].id, 'iB');
    assert.strictEqual(B.state.priorities[t][0].text, 'ship it');
  });

  await test('same setting edited on both while offline: newest edit wins everywhere (either reconnect order)', async () => {
    for (const order of [['A', 'B'], ['B', 'A']]) {
      const server = makeServer();
      let clock = 5_000;
      const A = makeDevice(server, 'A', baseState()); A.engine.start('u1'); await settle();
      const B = makeDevice(server, 'B', baseState()); B.engine.start('u1'); await settle();
      const devs = { A, B };
      A.backend.setOnline(false); B.backend.setOnline(false);
      const realNow = Date.now;
      Date.now = () => ++clock + realNow.call(Date) * 0 + 1e12; // deterministic, B edits later
      A.edit(s => { s.settings.grace = 15; });
      B.edit(s => { s.settings.grace = 20; });
      Date.now = realNow;
      await settle();
      devs[order[0]].backend.setOnline(true); devs[order[1]].backend.setOnline(true);
      await settle(60);
      assertSame(A, B, `converged (${order.join('→')})`);
      assert.strictEqual(A.state.settings.grace, 20, `newest edit wins (${order.join('→')})`);
    }
  });

  await test('no feedback loop: quiet devices stop writing', async () => {
    const server = makeServer();
    const A = makeDevice(server, 'A', baseState({ days: { '2026-10-01': dayWith(1, ['done', 'pending']) } }));
    A.engine.start('u1'); await settle();
    const B = makeDevice(server, 'B', baseState()); B.engine.start('u1'); await settle();
    A.edit(s => { s.days['2026-10-01'].blocks[1].status = 'missed'; });
    await settle(60);
    const w = server.writes;
    await settle(80);
    assert.strictEqual(server.writes, w, 'no further writes once settled');
    assert.strictEqual(A.engine.pending() + B.engine.pending(), 0);
  });

  await test('signing in with existing data → "merge" de-duplicates habits and keeps both histories', async () => {
    const server = makeServer();
    const A = makeDevice(server, 'A', baseState({ habitLog: { '2026-09-29': { hA: true } }, inbox: [{ id: 'iA', text: 'desk task', created: '2026-10-01' }] }));
    A.engine.start('u1'); await settle();
    const C = makeDevice(server, 'C', baseState({
      createdAt: '2026-09-20',
      habits: [{ id: 'hC', name: 'gym ', emoji: '🏋️', created: '2026-09-20', archived: null }, { id: 'hRead', name: 'Read', emoji: '📖', created: '2026-09-20', archived: null }],
      habitLog: { '2026-09-29': { hC: true }, '2026-09-25': { hC: true, hRead: true } },
      inbox: [{ id: 'iC', text: 'phone task', created: '2026-10-01' }],
    }), 'merge');
    C.engine.start('u1'); await settle(60);
    assert.deepStrictEqual(C.state.habits.map(h => h.name), ['Gym', 'Read'], 'Gym not duplicated');
    assert.strictEqual(C.state.habits[0].created, '2026-09-20', 'keeps the earliest start date');
    assert.deepStrictEqual(C.state.habitLog['2026-09-25'], { hA: true, hRead: true }, 'history remapped onto the account habit');
    assert.deepStrictEqual(C.state.inbox.map(i => i.id).sort(), ['iA', 'iC']);
    assert.strictEqual(snapshot(A.state), snapshot(C.state), 'A received the merged result');
  });

  await test('restart resumes incrementally and re-sends unacknowledged edits', async () => {
    const server = makeServer();
    const A = makeDevice(server, 'A', baseState()); A.engine.start('u1'); await settle();
    A.backend.setOnline(false);
    A.edit(s => { s.inbox.push({ id: 'iX', text: 'queued', created: '2026-10-01' }); });
    await settle();
    A.engine.stop();                       // app closed while offline, before the server got it
    A.backend.setOnline(true);
    await settle();
    A.engine.start('u1'); await settle(60); // reopened
    const B = makeDevice(server, 'B', baseState()); B.engine.start('u1'); await settle(60);
    assert.deepStrictEqual(B.state.inbox.map(i => i.id), ['iX']);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
