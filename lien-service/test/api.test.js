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

test('health check responds', async () => {
  const r = await fetch(`${base}/health`);
  assert.deepStrictEqual(await r.json(), { ok: true });
});

test('disburses an approved loan net of the processing fee', async () => {
  const loan = store.db.prepare("SELECT id FROM loans WHERE status = 'approved' LIMIT 1").get();
  const r = await fetch(`${base}/api/loans/${loan.id}/disburse`, { method: 'POST' });
  const body = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(body.disbursed, 98250); // 100000 less 1.75%
});

test('refuses to disburse a loan that is not approved', async () => {
  const loan = store.db.prepare("SELECT id FROM loans WHERE status = 'disbursed' LIMIT 1").get();
  const r = await fetch(`${base}/api/loans/${loan.id}/disburse`, { method: 'POST' });
  assert.strictEqual(r.status, 409);
});

test('returns 404 for an unknown loan', async () => {
  const r = await fetch(`${base}/api/loans/999999/disburse`, { method: 'POST' });
  assert.strictEqual(r.status, 404);
});

test('ledger pagination reports the correct total', async () => {
  const r = await fetch(`${base}/api/ledger?user_id=1&page=1&limit=3`);
  const body = await r.json();
  assert.strictEqual(body.total, store.countLedger(1));
  assert.ok(Array.isArray(body.entries));
});

test('statement includes accrued interest', async () => {
  const loan = store.db.prepare("SELECT id FROM loans WHERE status = 'disbursed' LIMIT 1").get();
  const r = await fetch(`${base}/api/loans/${loan.id}/statement?days=0`);
  const body = await r.json();
  assert.strictEqual(body.interest_accrued, 0);
  assert.strictEqual(body.payable, body.principal);
});

test('ledger entries are ordered by id', async () => {
  const r = await fetch(`${base}/api/ledger?user_id=1&page=1&limit=50`);
  const { entries } = await r.json();
  const ids = entries.map((e) => e.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b));
});
