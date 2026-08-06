'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../src/app');
const { seed } = require('../src/seed');
const store = require('../src/db');

let server;
let base;

test.before(async () => {
  seed({ users: 1, disbursalsPerUser: 5 });
  await new Promise((resolve) => {
    server = build().listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server && server.close());

test('ledger pagination offset issue fix', async () => {
  const total = store.countLedger(1);
  assert.ok(total >= 4);

  const r1 = await fetch(`${base}/api/ledger?user_id=1&page=1&limit=3`);
  const body1 = await r1.json();

  const r2 = await fetch(`${base}/api/ledger?user_id=1&page=2&limit=3`);
  const body2 = await r2.json();

  assert.strictEqual(r1.status, 200);
  assert.strictEqual(body1.entries.length, 3);

  assert.notStrictEqual(
    body1.entries[0].id,
    body2.entries[0].id
  );

  const allR = await fetch(`${base}/api/ledger?user_id=1&page=1&limit=100`);
  const allBody = await allR.json();
  const smallestId = Math.min(...allBody.entries.map((e) => e.id));
  assert.strictEqual(body1.entries[0].id, smallestId);
});

test('prevent duplicate disbursal under concurrent requests', async () => {
  const loan = store.db.prepare("SELECT * FROM loans WHERE status = 'approved' LIMIT 1").get();
  assert.ok(loan);

  const balanceBefore = await store.getWalletBalance(loan.user_id);

  const [r1, r2] = await Promise.all([
    fetch(`${base}/api/loans/${loan.id}/disburse`, { method: 'POST' }),
    fetch(`${base}/api/loans/${loan.id}/disburse`, { method: 'POST' }),
  ]);

  const statuses = [r1.status, r2.status];
  assert.ok(statuses.includes(200));
  assert.strictEqual(statuses.filter((s) => s === 200).length, 1);

  const balanceAfter = await store.getWalletBalance(loan.user_id);
  const fee = loan.principal * 0.0175;
  const expectedNet = loan.principal - fee;
  assert.ok(Math.abs((balanceAfter - balanceBefore) - expectedNet) < 0.01);
});

test('daily-close difference zero check', async () => {
  seed({ users: 1, disbursalsPerUser: 420 });

  const r = await fetch(`${base}/api/ops/daily-close?user_id=1`);
  const body = await r.json();
  assert.strictEqual(body.difference, 0);
});
