# NOTES

## AI Usage

I used Google Antigravity (Claude Sonnet 4.6 with Thinking) as a coding assistant during the assignment. It helped generate test scaffolding and some boilerplate for the reconciliation script. I validated every change myself, reasoned through each bug, and verified the outputs before finalizing the solution. The design decisions and Part 3 answer are entirely my own.

---

## Part 1 — Defects

### Defect 1: Pagination Off-by-One

**Symptom**

`GET /api/ledger?page=1` skipped the first page and returned what was effectively page 2.

**Root Cause**

The offset was calculated as `page * limit` even though pagination is 1-indexed. As a result, the first set of records could never be retrieved.

**Fix**

Changed the calculation to `(page - 1) * limit`.

**How I'd Prevent It**

I'd keep an integration test that verifies page 1 always returns the very first record. Pagination bugs are small but easy to miss, and a simple regression test prevents them from coming back.

---

### Defect 2: Double Disbursal Race Condition

**Symptom**

If two disbursal requests hit the API at the same time, both succeeded and credited the wallet twice.

**Root Cause**

The endpoint checked whether the loan was approved, but never atomically changed its status before crediting the wallet. Both requests passed the same validation before either finished writing.

**Fix**

I introduced an atomic update that changes the loan status from `approved` to `disbursed` before any wallet update happens. Only the request that successfully updates the status proceeds; the other returns a conflict.

**How I'd Prevent It**

Financial workflows should never rely on separate "check then update" operations. State transitions should always happen atomically so that only one request can succeed.

---

### Defect 3: Money Precision & Settlement Mismatch

**Symptom**

The daily settlement report consistently showed a difference. With a few hundred transactions, the accumulated mismatch became significant.

**Root Cause**

Money was being calculated using floating-point arithmetic in some places while integer paise calculations were used elsewhere. Small rounding differences accumulated over hundreds of transactions.

The settlement calculation also summed floating-point values in JavaScript, introducing additional precision errors.

**Fix**

* Switched all fee calculations to integer paise.
* Stored net values using integer arithmetic before converting back to rupees.
* Performed settlement aggregation in SQL using integer paise instead of floating-point values.

**How I'd Prevent It**

Money should always be represented in the smallest unit (paise/cents) internally. Conversions to decimal values should only happen when displaying data through the API or UI.

---

## Part 3 — Judgment Question

If the webhook is delivered twice, both requests could attempt to disburse the same loan. Without an atomic state transition, the borrower may receive the amount twice.

If the webhook arrives before the loan record has been committed, the handler may not find the loan. Depending on the implementation, the event could be lost or ignored, resulting in a loan that is never disbursed.

To make this safe, I'd solve these as two separate problems.

For duplicate webhooks, I'd make the loan status transition atomic. Only the request that successfully changes the loan from `approved` to `disbursed` should continue with the wallet credit. Any later request should become a safe no-op.

For early webhooks, instead of failing immediately, I'd persist the webhook as a pending disbursal intent. Once the loan record is committed, the application can process any pending intents in the same transaction. This avoids losing events while keeping the webhook handler lightweight.

One additional concern is replication lag. If loan creation and webhook processing happen on different database replicas, one service may not immediately see the other's writes. In that case I'd either route these operations to the primary database or add a short retry with exponential backoff before treating the loan as missing.

The key takeaway is that duplicate delivery and out-of-order delivery are different failure modes. Solving only one still leaves the system vulnerable.
