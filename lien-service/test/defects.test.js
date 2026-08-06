'use strict';
/**
 * Defect regression tests — these MUST FAIL against the original code.
 *
 * Defect 1: Pagination off-by-one — page=1 skips the first page entirely.
 * Defect 2: Double-disbursal race condition — concurrent requests disburse the same loan twice.
 * Defect 3: Floating-point fee rounding — daily-close always shows a non-zero difference.
 */
const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../src/app');
const { seed } = require('../src/seed');
const store = require('../src/db');

let server;
let base;

test.before(async () => {
  // Seed with enough data to expose the bulk-rounding defect (defect 3)
  // and enough entries to expose the pagination defect (defect 1).
  seed({ users: 1, disbursalsPerUser: 5 });
  await new Promise((resolve) => {
    server = build().listen(0, () => {
      base = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => server && server.close());

// ─── Defect 1: Pagination off-by-one ─────────────────────────────────────────
// page=1 with limit=3 should return the first 3 entries (IDs 1,2,3).
// The buggy code computes OFFSET = page * limit = 1*3 = 3, skipping them all.
test('defect 1: page=1 returns the FIRST page of ledger entries, not the second', async () => {
  // Make sure there are at least 4 entries so the difference is observable.
  const total = store.countLedger(1);
  assert.ok(total >= 4, `need ≥4 entries to distinguish page 1 from page 2, have ${total}`);

  const r1 = await fetch(`${base}/api/ledger?user_id=1&page=1&limit=3`);
  const body1 = await r1.json();

  const r2 = await fetch(`${base}/api/ledger?user_id=1&page=2&limit=3`);
  const body2 = await r2.json();

  assert.strictEqual(r1.status, 200);
  assert.strictEqual(body1.entries.length, 3, 'page 1 should have 3 entries');

  // The first entry on page=1 must be different from the first entry on page=2.
  // The buggy code makes page=1 and page=2 return the same entries.
  assert.notStrictEqual(
    body1.entries[0].id,
    body2.entries[0].id,
    'page 1 and page 2 must return different entries; buggy code returns the same set'
  );

  // Stronger assertion: page=1 must contain the smallest IDs.
  const allR = await fetch(`${base}/api/ledger?user_id=1&page=1&limit=100`);
  const allBody = await allR.json();
  const smallestId = Math.min(...allBody.entries.map((e) => e.id));
  assert.strictEqual(
    body1.entries[0].id,
    smallestId,
    `page=1 first entry id (${body1.entries[0].id}) must be the smallest in the ledger (${smallestId})`
  );
});

// ─── Defect 2: Double-disbursal race condition ────────────────────────────────
// Two concurrent POST requests for the same approved loan must result in exactly
// one disbursal.  The buggy code has no atomic guard, so both succeed.
test('defect 2: concurrent disbursal of the same loan credits the wallet exactly once', async () => {
  const loan = store.db.prepare("SELECT * FROM loans WHERE status = 'approved' LIMIT 1").get();
  assert.ok(loan, 'need an approved loan');

  const balanceBefore = await store.getWalletBalance(loan.user_id);

  // Fire two simultaneous disbursal requests.
  const [r1, r2] = await Promise.all([
    fetch(`${base}/api/loans/${loan.id}/disburse`, { method: 'POST' }),
    fetch(`${base}/api/loans/${loan.id}/disburse`, { method: 'POST' }),
  ]);

  const statuses = [r1.status, r2.status];
  // Exactly one should succeed (200) and one should be rejected (409 or 4xx).
  assert.ok(
    statuses.includes(200),
    `at least one request must succeed; got ${statuses}`
  );
  assert.ok(
    statuses.includes(409) || statuses.filter((s) => s === 200).length === 1,
    `only ONE request must succeed; got ${statuses}`
  );
  assert.strictEqual(
    statuses.filter((s) => s === 200).length,
    1,
    `exactly one 200 expected, got ${statuses}`
  );

  // Wallet must have been credited exactly once.
  const balanceAfter = await store.getWalletBalance(loan.user_id);
  const fee = loan.principal * 0.0175;
  const expectedNet = loan.principal - fee;
  assert.ok(
    Math.abs((balanceAfter - balanceBefore) - expectedNet) < 0.01,
    `wallet credited ${balanceAfter - balanceBefore} but expected ~${expectedNet} (one disbursal)`
  );
});

// ─── Defect 3: Floating-point fee rounding ────────────────────────────────────
// After seeding, the daily-close endpoint should show difference = 0.
// The buggy code stores ledger amounts via float arithmetic (principal - principal*0.0175)
// while control_totals uses integer-paise math — with 420 entries the gap accumulates
// to tens of thousands of rupees.
test('defect 3: daily-close difference is exactly zero (fee computed in integer paise)', async () => {
  // Re-seed with the full 420-per-user dataset so the rounding discrepancy accumulates.
  // All 420 entries and their control total are inserted by seed(); no live disbursal
  // is needed — if the rounding is wrong anywhere, the sum won't match.
  seed({ users: 1, disbursalsPerUser: 420 });

  const r = await fetch(`${base}/api/ops/daily-close?user_id=1`);
  const body = await r.json();
  assert.strictEqual(
    body.difference,
    0,
    `daily-close difference must be 0; got ${body.difference} (accumulated rounding error over ${body.entries} entries)`
  );
});
