'use strict';
/**
 * recon.js — Reconcile internal_ledger.json against amc_statement.csv
 * for the settlement date 15 July 2026.
 *
 * Run: node recon.js
 */

const fs = require('fs');
const path = require('path');

// ─── 1. Parse internal ledger ────────────────────────────────────────────────
// Already filtered to 15-Jul-2026 IST (per DATA_DICTIONARY.md).
const ledgerRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'internal_ledger.json'), 'utf8'));
const ledger = ledgerRaw.entries ?? ledgerRaw.transactions ?? ledgerRaw;

// Build a map txn_id → amount_inr
const ledgerMap = new Map();
for (const row of ledger) {
  ledgerMap.set(row.txn_id, row.amount_inr);
}
console.log(`Ledger entries: ${ledgerMap.size}`);

// ─── 2. Parse AMC CSV ─────────────────────────────────────────────────────────
function parseAmount(raw) {
  if (!raw) return 0;
  // Strip leading/trailing whitespace
  let s = raw.trim();
  // Strip "Rs." or "Rs " prefix (case-insensitive)
  s = s.replace(/^Rs\.?\s*/i, '');
  // Strip trailing "/-" (debit notation)
  s = s.replace(/\/-$/, '');
  // Strip commas (Indian number format: 8,39,225.32)
  s = s.replace(/,/g, '');
  return parseFloat(s);
}

const csvText = fs.readFileSync(path.join(__dirname, 'amc_statement.csv'), 'utf8');
const csvLines = csvText.split('\n');
const csvHeader = csvLines[0].trim().split(',').map(s => s.trim());
const idxRef    = csvHeader.indexOf('reference');
const idxDate   = csvHeader.indexOf('settled_at_utc');
const idxAmt    = csvHeader.indexOf('amount');
const idxStatus = csvHeader.indexOf('status');

// Settlement date window in UTC: 15-Jul-2026 IST = 14-Jul-2026 18:30 UTC … 15-Jul-2026 18:29:59 UTC
// But DATA_DICTIONARY says the file is *not* restricted to one date, so we must filter.
// IST = UTC + 5:30. Settlement date 15-Jul-2026 IST starts at 2026-07-14T18:30:00Z.
const IST_START_UTC = new Date('2026-07-14T18:30:00Z');
const IST_END_UTC   = new Date('2026-07-15T18:30:00Z');

const amcRows = [];
for (let i = 1; i < csvLines.length; i++) {
  const line = csvLines[i].trim();
  if (!line) continue;

  // CSV rows may have commas inside the amount field (quoted). Parse carefully.
  // Strategy: split on comma, but the amount is quoted ("8,39,225.32").
  // Use a simple quoted-CSV parser.
  const cols = parseCsvRow(line);
  if (cols.length < 4) continue;

  const reference    = cols[idxRef]?.trim();
  const settledAtUtc = cols[idxDate]?.trim();
  const amountRaw    = cols[idxAmt]?.trim();
  const status       = cols[idxStatus]?.trim();

  // Filter: only SETTLED rows count towards the settlement total
  if (status !== 'SETTLED') continue;

  // Filter by settlement date in UTC (which maps to IST date boundary)
  const ts = new Date(settledAtUtc.replace(' ', 'T') + 'Z');
  if (ts < IST_START_UTC || ts >= IST_END_UTC) continue;

  amcRows.push({ reference, settledAtUtc, amount: parseAmount(amountRaw), status });
}
console.log(`AMC SETTLED rows in settlement window: ${amcRows.length}`);

function parseCsvRow(line) {
  const cols = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' ) { inQuote = !inQuote; continue; }
    if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

// ─── 3. Deduplication — gateway retries ───────────────────────────────────────
// "A retry appears as a second row with the same reference and the same amount,
//  seconds apart. The money moved once."
// Strategy: group rows by (reference, amount). If a reference appears more than
// once with the same amount, keep only one.
const seenRetry = new Map(); // key: `${reference}|${amount}` → already-counted boolean
const amcDeduped = [];
for (const row of amcRows) {
  const key = `${row.reference}|${row.amount}`;
  if (seenRetry.has(key)) {
    console.log(`  RETRY deduped: ${row.reference} amount=${row.amount}`);
    continue;
  }
  seenRetry.set(key, true);
  amcDeduped.push(row);
}
console.log(`AMC rows after retry dedup: ${amcDeduped.length}`);

// ─── 4. Match AMC rows to ledger entries ──────────────────────────────────────
// Most references match 1:1 with a txn_id.
// Multi-leg redemptions: reference is TXNxxx-1, TXNxxx-2 etc. — map to base txn_id.

// Group AMC rows by base txn_id (strip trailing -N suffix)
const amcByBase = new Map(); // base txn_id → array of AMC rows
for (const row of amcDeduped) {
  const base = row.reference.replace(/-\d+$/, '');
  if (!amcByBase.has(base)) amcByBase.set(base, []);
  amcByBase.get(base).push(row);
}

let matchedCount = 0;
let amcSettledTotal = 0;   // sum of all SETTLED AMC amounts in window
let ledgerTotal = 0;       // sum of matched ledger amounts
const unexplainedRefs = [];
const matchedLedgerIds = new Set();

for (const [baseTxnId, rows] of amcByBase) {
  const amcSum = rows.reduce((s, r) => s + r.amount, 0);
  amcSettledTotal += amcSum;

  if (ledgerMap.has(baseTxnId)) {
    // Matched
    const ledgerAmt = ledgerMap.get(baseTxnId);
    matchedLedgerIds.add(baseTxnId);
    matchedCount++;
    ledgerTotal += ledgerAmt;

    const diff = Math.round((amcSum - ledgerAmt) * 100) / 100;
    if (Math.abs(diff) > 0.005) {
      console.log(`  AMOUNT MISMATCH: ${baseTxnId}  AMC=${amcSum.toFixed(2)}  ledger=${ledgerAmt.toFixed(2)}  diff=${diff}`);
    }
    if (rows.length > 1) {
      console.log(`  MULTI-LEG: ${baseTxnId} legs=${rows.length} AMC_sum=${amcSum.toFixed(2)} ledger=${ledgerAmt.toFixed(2)}`);
    }
  } else {
    // Cannot match to a ledger txn
    unexplainedRefs.push(...rows.map(r => r.reference));
    console.log(`  UNEXPLAINED: ${rows.map(r => r.reference).join(', ')}  amount=${amcSum.toFixed(2)}`);
  }
}

// Any ledger entries with no AMC counterpart
const unmatchedLedger = [];
for (const [txnId, amt] of ledgerMap) {
  if (!matchedLedgerIds.has(txnId)) {
    unmatchedLedger.push({ txn_id: txnId, amount_inr: amt });
  }
}
if (unmatchedLedger.length) {
  console.log(`\nLedger entries with no AMC match (${unmatchedLedger.length}):`);
  for (const e of unmatchedLedger) {
    console.log(`  ${e.txn_id}  ${e.amount_inr}`);
  }
}

// ─── 5. Compute final figures ─────────────────────────────────────────────────
// unmatched_amount_inr = AMC settled total − ledger total, after resolving
// all explainable discrepancies (multi-leg legs are explained, retries are deduped).
const unmatchedAmountInr = Math.round((amcSettledTotal - ledgerTotal) * 100) / 100;

console.log(`\n─── Summary ───`);
console.log(`AMC settled total (in window, deduped):  ${amcSettledTotal.toFixed(2)}`);
console.log(`Ledger matched total:                    ${ledgerTotal.toFixed(2)}`);
console.log(`matched_count:                           ${matchedCount}`);
console.log(`unmatched_amount_inr:                    ${unmatchedAmountInr.toFixed(2)}`);
console.log(`unexplained_references (${unexplainedRefs.length}):          ${JSON.stringify(unexplainedRefs)}`);

const answer = {
  matched_count: matchedCount,
  unmatched_amount_inr: Number(unmatchedAmountInr.toFixed(2)),
  unexplained_references: unexplainedRefs,
};

fs.writeFileSync(path.join(__dirname, 'answer.json'), JSON.stringify(answer, null, 2));
console.log('\nWrote answer.json');
