# NOTES

## AI usage

Used Google Antigravity (Claude Sonnet 4.6 with Thinking) as a coding assistant throughout. It helped write the test skeletons and the recon parsing boilerplate; I drove the reasoning about each defect, directed the fixes, and verified every output. The judgment in Part 3 is my own.

---

## Part 1 — Defects

### Defect 1: Pagination off-by-one

**Symptom:** `GET /api/ledger?page=1` skips the first page entirely and returns what is actually page 2.

**Root cause:** `pageLedger` in `db.js` computes `OFFSET = page * limit`. Since `page` is 1-indexed, page=1 should produce `OFFSET 0 = (1−1)*limit`. The buggy formula gives `OFFSET 1*limit`, which skips the whole first page. Page 1 and page 2 return the same rows; the true first page is unreachable.

**Fix:** Changed to `(page - 1) * limit`.

**Prevention:** An integration test asserting that the first entry returned by page=1 is the globally smallest ID. This is the kind of fence-post error that code review often misses; only a test that checks actual data catches it.

---

### Defect 2: Double-disbursal race condition

**Symptom:** Two simultaneous `POST /api/loans/:id/disburse` requests for the same approved loan both return 200 and each credits the wallet, resulting in the borrower receiving twice the loan amount.

**Root cause:** The endpoint reads `loan.status`, checks it is `'approved'`, then proceeds to write wallet balance — but never updates `status` to `'disbursed'`. There is no atomic guard. Under any concurrency (even a single Node event loop re-entry during the simulated `await wait()` in `db.js`), both requests race past the status check and both complete.

**Fix:** Added `markLoanDisbursed(loanId)` which does `UPDATE loans SET status='disbursed' WHERE id=? AND status='approved'` and returns `result.changes`. The disburse endpoint calls this *before* touching the wallet; if `changes === 0` it returns 409. SQLite serialises writes, so exactly one caller will get `changes=1`.

**Prevention:** Rule: every financial state machine transition (approved → disbursed) must be a single conditional `UPDATE` that acts as an atomic compare-and-swap. Code review checklist item: *"Can two requests for the same resource both pass this guard?"*

---

### Defect 3: Floating-point fee rounding (invisible until you look at hundreds of transactions)

**Symptom:** `/api/ops/daily-close` shows a non-zero `difference` for every user. With 420 disbursals the accumulated error was **₹98,249.97** — roughly one full disbursal's net amount, which makes it look like an entire transaction is missing rather than a rounding error.

**Root cause:** Two separate rounding errors working together:

1. `seed.js` stored ledger amounts as `principal - principal * 0.0175` (floating-point rupees), but computed `control_totals` using integer-paise arithmetic: `Math.round(principalPaise * 175 / 10000)`. For most principals these diverge by up to half a paisa; over 420 entries they accumulate.

2. `app.js` computed the fee the same floating-point way, so live disbursals would also diverge from the partner's figure.

3. The daily-close `ledgerSum` was computed by iterating and summing REAL values in JavaScript — which adds a second layer of floating-point accumulation on top.

**Fix:**
- `seed.js`: compute `net = netPaise / 100` (not float subtraction) so ledger entries and control_total agree from the start.
- `app.js` disburse: compute fee in integer paise (`Math.round(principalPaise * 175 / 10000)`), convert back at the end.
- `app.js` daily-close: sum in paise via `SUM(CAST(ROUND(amount * 100) AS INTEGER))` in SQL; divide by 100 once at the end.

**Prevention:** Rule: **never store or compare money as floating-point**. Use integer paise throughout, store as `INTEGER` in the database, and convert to rupees only at the API boundary. Enforce with a lint rule or type alias. The daily-close control check itself is the right kind of defence — the problem was that the code it checked against had the same bug it was supposed to catch.

---

## Part 3 — Judgment question

> We disburse a loan the moment the AMC's webhook confirms the lien. In production we have seen that webhook fire twice for the same lien, and we have seen it arrive before our own database write for that loan has committed. What breaks, and how would you make disbursal safe against both?

**What breaks:**

The duplicate webhook: if two deliveries race through the handler, both read the loan as `status='approved'` and both disburse. The borrower receives twice the principal; we've debited the AMC once. This is the same class of bug as Defect 2 — a check-then-act without an atomic guard.

The early webhook: if the webhook arrives before our `INSERT INTO loans` has committed, the handler does a `getLoan` and finds nothing. Most implementations either return 404 and the webhook is lost (the AMC never retries; the loan is never disbursed) or silently succeed and drop the event. Either outcome is wrong money.

**How I would fix both:**

For the duplicate: the loan status update must be an atomic compare-and-swap, exactly as in the Defect 2 fix — `UPDATE loans SET status='disbursed' WHERE id=? AND status='approved'`. Only the request that sees `changes=1` proceeds to wallet mutation. The second delivery hits `changes=0` and gets an idempotent 200 (or 409) without touching money. The key insight is that idempotency belongs at the database layer, not in application-level "did we see this webhook before?" checks, which have their own race conditions.

For the early arrival: I would not try to make the webhook handler wait for the DB write — that couples two systems in a fragile way. Instead: if the handler finds no loan, it writes a "pending disbursal intent" row (a different table, keyed on lien_id) and returns 200 to the AMC so it doesn't retry. When our own loan-creation commit lands, it checks for a pending intent and triggers disbursal then. This is a local outbox pattern. The loan creation and the intent check both need to be in the same transaction, or the same race reappears.

The thing I'd watch for that isn't obvious: both fixes assume the webhook handler and the loan-creation path share the same database. If they go through separate services or replicas with replication lag, "the loan exists" can be true on one node and false on another. In that case you need either sticky routing (always hit the primary for this loan_id) or a short retry with backoff in the intent-check, which I'd rather have than a distributed lock.

The two root causes are different (idempotency vs ordering), and they need different fixes. Trying to solve both with a single "webhook dedup table" misses the ordering problem entirely — you can deduplicate a webhook that arrived before your DB was ready and still lose the disbursal.
