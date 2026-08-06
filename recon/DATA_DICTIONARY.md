# Data dictionary — 15 July 2026 settlement

Two systems, one day. Read this before writing any code.

## `internal_ledger.json`

Our record of transactions booked for the settlement date.

| Field | Meaning |
|---|---|
| `txn_id` | Our transaction reference |
| `amount_inr` | Rupees, already numeric, 2 decimal places |
| `booked_at_ist` | When we booked it. **Asia/Kolkata (UTC+5:30).** |
| `folio` | The borrower's folio with the AMC |

This file contains only transactions booked on the settlement date, in IST.

## `amc_statement.csv`

What the AMC sent us.

| Column | Meaning |
|---|---|
| `reference` | The AMC's reference for the transaction |
| `settled_at_utc` | **UTC.** Their systems run on UTC; ours run on IST. |
| `amount` | Rupees, as rendered by their reporting tool |
| `status` | See below |

This file is *not* restricted to a single settlement date.

### `status` values

| Value | Meaning |
|---|---|
| `SETTLED` | Money has moved. Counts towards the settlement total. |
| *(blank)* | **Pending.** Instructed but not yet settled. Does **not** count towards the settlement total on either side. A blank status is not a failure. |

### On the `amount` column

The AMC's reporting tool is old and its number formatting is not consistent
between rows. Look at the raw column before you decide how to parse it.

### On references

Most AMC references correspond one-to-one with a `txn_id` on our side.

Where the AMC could not settle a redemption in a single movement — typically
because the units sat across more than one scheme plan — it settles in legs and
suffixes the reference (`...-1`, `...-2`). Our side books the redemption once,
as a single row.

The AMC's payment gateway also retries on timeout. A retry appears on the
statement as a second row with the **same reference and the same amount**,
seconds apart. The money moved once.

## The settlement date

The settlement date is **15 July 2026, IST**. A transaction belongs to this
settlement date based on when it occurred in IST, not UTC.
