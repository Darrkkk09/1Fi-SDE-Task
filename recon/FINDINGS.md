# Reconciliation Findings — 15 July 2026

## Overview

| | Count | Amount (INR) |
|---|---|---|
| Internal ledger entries | 3,840 | — |
| AMC SETTLED rows (in settlement window) | 3,835 | 1,703,586,504.18 |
| After retry deduplication | 3,832 | — |
| **Matched** | **3,829** | **1,703,575,223.35** |

**matched_count: 3829**  
**unmatched_amount_inr: 11,280.83**  
**unexplained_references: ["TXNA0DFE6900001"]**

---

## Discrepancies Found and How I Treated Them

### 1. Gateway retries (3 duplicate rows) — Explained, excluded

**References:** `TXNA0DFE6200000`, `TXNA0DFE6200001`, `TXNA0DFE6200002`

**Symptom:** Each appears twice in the AMC CSV on the same date, with identical amounts and references, seconds apart.

**Cause:** Per DATA_DICTIONARY.md: "The AMC's payment gateway retries on timeout. A retry appears on the statement as a second row with the same reference and the same amount. The money moved once."

**Treatment:** Kept the first occurrence of each (reference, amount) pair; discarded the duplicate. The money moved once, and our ledger records it once, so no monetary impact.

---

### 2. Multi-leg redemptions (2 transactions, 4 AMC rows) — Explained, matched

**References:**  
- `TXNA0DFE6400000-1` + `TXNA0DFE6400000-2` → `TXNA0DFE6400000`  
- `TXNA0DFE6400001-1` + `TXNA0DFE6400001-2` → `TXNA0DFE6400001`

**Symptom:** The AMC reports two rows with the same base reference (suffixed `-1`, `-2`) that each sum to the ledger amount.

**Cause:** Per DATA_DICTIONARY.md: "Where the AMC could not settle a redemption in a single movement — typically because the units sat across more than one scheme plan — it settles in legs."

**Treatment:** Stripped the `-N` suffix, grouped by base txn_id, summed the legs. Both sum exactly to the ledger amounts (`₹474,230.15` and `₹245,249.40`). Counted as 2 matched transactions.

---

### 3. 11 ledger entries present in AMC as "pending" — Explained, excluded from both sides

**References:** `TXNA0DFE6500000` through `TXNA0DFE6500010`

**Symptom:** 11 transactions appear in our internal ledger but appear to have no SETTLED counterpart on the AMC side — they only show up in the AMC CSV with a blank `status` field.

**Cause:** Per DATA_DICTIONARY.md: "A blank status is pending. Instructed but not yet settled. Does **not** count towards the settlement total on either side."

**Treatment:** Correctly excluded from the AMC settled total (filtered during parsing). These entries exist on our side but the AMC has not yet settled them — they should appear in the next settlement cycle's SETTLED rows. **No monetary discrepancy; these are in-flight.**

Total pending amount (our ledger, not counted): **₹2,247,058.83**

---

### 4. Inconsistent AMC amount formatting — Addressed during parsing

**Symptom:** The `amount` column had at least three different formats in the same file:
- `"8,39,225.32"` — Indian number format with commas
- `"7,59,915.13/-"` — trailing `/-` debit notation
- `"Rs. 3,01,083.61"` — leading `Rs.` prefix

**Treatment:** Stripped `Rs.`/`Rs ` prefix, `/-` suffix, and all commas before parsing to float. Verified by cross-checking amounts on matched rows.

---

## What I Cannot Account For

### TXNA0DFE6900001 — ₹11,280.83 — **UNEXPLAINED**

The AMC reports `TXNA0DFE6900001` as `SETTLED` for **₹11,280.83** on 15 July 2026 at 10:35 UTC. This reference:

- **Does not exist in our internal ledger** under any txn_id, including as a base reference.
- **Is not a leg** of any other transaction (no `TXNA0DFE690000x-N` pattern elsewhere).
- **Is not a retry** of another row (no other row with the same reference or amount).
- **Is not pending** — status is explicitly `SETTLED`.

This means the AMC moved ₹11,280.83 that we have no record of instructing. This is the residual `unmatched_amount_inr`.

**I am not absorbing this figure silently.** In a production context I would:
1. Raise it immediately as a financial exception requiring manual investigation.
2. Check whether this reference was issued by a different system (e.g. a direct AMC portal instruction, a test transaction, or a mistaken credit to our folio).
3. Do not book it on our side until the source is identified — booking an unexplained credit is just as dangerous as losing it.

---

## Figures

```
AMC settled total (window, deduped):    ₹1,703,586,504.18
Ledger matched total:                   ₹1,703,575,223.35
Difference (AMC − ledger matched):         ₹11,280.83   ← all TXNA0DFE6900001
```

The ₹11,280.83 is the `unmatched_amount_inr` in `answer.json`. It is entirely explained by the single unexplained AMC reference — no other residual exists.
