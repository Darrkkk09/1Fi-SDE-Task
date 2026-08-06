# 1Fi — SDE Intern Assignment

**Timebox: 2 hours.** We mean it. Set a timer, stop when it goes off, and submit
whatever you have. An honest partial submission with clear notes beats a polished
one that took six hours — we would rather see how you prioritise under a real
constraint.

## About the AI policy — read this first

**Use any AI tool you like.** Claude, Cursor, Copilot, whatever you normally
reach for. We are not testing whether you can write code without help; nobody on
our team does that either.

Two conditions:

1. In `NOTES.md`, tell us what you used and roughly where. One or two lines.
2. You will be asked to walk through your submission on a 25-minute call and
   make a change to it live. Every line needs to be a line you can explain.

Candidates who say "I used Claude for the parsing and wrote the reconciliation
logic myself" do *better* in our process, not worse. Candidates who cannot
explain their own submission do not proceed, regardless of how good it looks.

Everyone gets the same data, and we are aware the final numbers will circulate.
That is why most of the marks are on your *reasoning*, not your figures — a
correct number with a thin write-up scores below a near-miss that shows its
working. Copying a number you did not derive will be obvious within about two
minutes of the follow-up call.

---

## Part 1 — Something is wrong with this service (≈60 min)

`lien-service/` is a cut-down version of our disbursal path. A borrower pledges
mutual fund units, we place a lien on them, and we disburse a loan into their
wallet net of a 1.75% processing fee.

```bash
cd lien-service
npm install
npm test      # 7 tests, all passing
npm start     # http://localhost:3000
```

The tests pass. The service starts. It is still wrong in **three** separate
ways, and each one would cost us real money in production.

They vary in difficulty. One you will spot by reading. One only appears when the
service is under concurrent load. One is invisible until you look at a few
hundred transactions at once.

For each defect you find:

1. **Write a failing test first** in `lien-service/test/`. It must fail against
   the current code. This matters more to us than the fix.
2. Fix it.
3. In `NOTES.md`, record: the symptom, the root cause, and — briefly — how you
   would stop this class of bug reaching production again.

If you only find two, say so. Do not pad `NOTES.md` with defects you did not
actually reproduce; we will check your tests against the original code.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/loans/:id/disburse` | Credits the wallet net of the 1.75% fee |
| `GET` | `/api/ledger?user_id=&page=&limit=` | `page` is **1-indexed** |
| `GET` | `/api/loans/:id/statement?days=` | Simple interest, 365-day count |
| `GET` | `/api/ops/daily-close?user_id=` | Compares our ledger against the figure our banking partner reports. These two numbers must agree exactly. |

---

## Part 2 — The settlement does not reconcile (≈45 min)

`recon/` holds two views of the same day's transactions for **15 July 2026**:

- `internal_ledger.json` — our system. Timestamps are **IST**.
- `amc_statement.csv` — what the asset management company sent us. Timestamps
  are **UTC**.

Operations says the two do not agree and cannot tell us why. Find out.

Read `recon/DATA_DICTIONARY.md` before you start. It is short and it matters.

Produce `recon/answer.json`:

```json
{
  "matched_count": 0,
  "unmatched_amount_inr": 0.00,
  "unexplained_references": []
}
```

- `matched_count` — transactions you could confidently match on both sides
- `unmatched_amount_inr` — AMC settled total minus our ledger total, in rupees
  to 2 decimal places, once you have resolved everything that is explainable
- `unexplained_references` — every AMC reference you could **not** account for

And `recon/FINDINGS.md`, which is the part we read most carefully:

- Each discrepancy you found, what caused it, and how you decided to treat it
- **Anything you could not explain.** Say so plainly. "I cannot account for
  ₹X and here is what I ruled out" is a strong answer. Quietly absorbing an
  unexplained figure into a total is the single worst thing you can do in
  financial software, and it is what we are watching for.

Commit your working script. A notebook is fine.

---

## Part 3 — One judgment question (≈15 min, no code)

In `NOTES.md`, under a `## Part 3` heading, answer in **under 300 words**:

> We disburse a loan the moment the AMC's webhook confirms the lien on the
> pledged units. In production we have seen that webhook fire twice for the
> same lien, and we have seen it arrive *before* our own database write for
> that loan has committed.
>
> What breaks, and how would you make disbursal safe against both?

We are looking for how you reason about a failure you have not personally hit,
not for the textbook answer.

---

## Submitting

1. Work in this repo. **Commit as you go** — we look at the history, and a
   single commit at the end tells us nothing about how you work.
2. Push to a **private** GitHub repo and add `@sourabhgir` as a collaborator.
3. Reply to the assignment email with the repo link.

**Deadline: 48 hours from when you receive this.** If something comes up, tell
us — we will move it. We would rather have your real work late than rushed work
on time.

## How we score this

| | |
|---|---|
| `FINDINGS.md` and `NOTES.md` — your reasoning | 30% |
| Defects found, reproduced and tested | 30% |
| Commit history and general craft | 15% |
| Reconciliation figures correct | 15% |
| Part 3 judgment answer | 10% |

Note that the reasoning is worth twice the figures. Note also what is *not* on
that list: code style, folder structure, test coverage percentage, or whether
you finished everything. We are hiring for judgment.

Questions are welcome — reply to the email. Asking a good clarifying question
counts in your favour.
