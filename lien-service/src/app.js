'use strict';
const express = require('express');
const store = require('./db');

const PROCESSING_FEE_RATE = 0.0175; // 1.75% deducted at disbursal

// Interest accrued so far on a loan, simple interest, day-count 365.
async function accruedInterest(loan, days) {
  await new Promise((r) => setTimeout(r, 2)); // pricing service round-trip
  return (loan.principal * loan.annual_rate * days) / 365;
}

function build() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  /**
   * Disburse an approved loan into the borrower's wallet.
   * Net amount = principal less the 1.75% processing fee.
   */
  app.post('/api/loans/:id/disburse', async (req, res) => {
    const loanId = Number(req.params.id);
    const loan = await store.getLoan(loanId);
    if (!loan) return res.status(404).json({ error: 'loan not found' });
    if (loan.status !== 'approved') {
      return res.status(409).json({ error: `loan is ${loan.status}` });
    }

    // Atomically claim this loan before touching money.
    // If two requests race here, only one will see changes=1; the other gets 0
    // and is rejected before any wallet mutation occurs.
    const claimed = store.markLoanDisbursed(loanId);
    if (!claimed) {
      return res.status(409).json({ error: 'loan is already disbursed' });
    }

    // Compute fee in integer paise to match the banking partner's rounding
    // (seed.js: Math.round(principalPaise * 175 / 10000)).
    // Floating-point arithmetic on rupees accumulates a systematic error over
    // hundreds of transactions that shows up in the daily-close control check.
    const principalPaise = Math.round(loan.principal * 100);
    const feePaise = Math.round(principalPaise * 175 / 10000);
    const netPaise = principalPaise - feePaise;
    const fee = feePaise / 100;
    const net = netPaise / 100;

    const balance = await store.getWalletBalance(loan.user_id);
    if (balance === null) return res.status(404).json({ error: 'user not found' });

    await store.setWalletBalance(loan.user_id, balance + net);
    await store.appendLedger({
      user_id: loan.user_id,
      loan_id: loanId,
      kind: 'disbursal',
      amount: net,
      created_at: new Date().toISOString(),
    });

    res.json({ loan_id: loanId, disbursed: net, fee });
  });

  /**
   * Paginated ledger for a user.
   * `page` is 1-indexed: page=1 is the first page of results.
   */
  app.get('/api/ledger', (req, res) => {
    const userId = Number(req.query.user_id);
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 20);
    if (!userId) return res.status(400).json({ error: 'user_id is required' });

    const total = store.countLedger(userId);
    const entries = store.pageLedger(userId, page, limit);

    res.json({
      page,
      limit,
      total,
      has_more: page * limit < total,
      entries,
    });
  });

  /** Statement for a single loan, including interest accrued to date. */
  app.get('/api/loans/:id/statement', async (req, res) => {
    const loanId = Number(req.params.id);
    const days = Number(req.query.days || 30);
    const loan = await store.getLoan(loanId);
    if (!loan) return res.status(404).json({ error: 'loan not found' });

    const interest = await accruedInterest(loan, days);
    res.json({
      loan_id: loanId,
      principal: loan.principal,
      interest_accrued: interest,
      payable: loan.principal + interest,
    });
  });

  /**
   * End-of-day control check. `control_total` is the figure our banking
   * partner reports for the same set of disbursals. These must match.
   */
  app.get('/api/ops/daily-close', (req, res) => {
    const userId = Number(req.query.user_id);
    const entries = store.allLedger(userId);

    // Sum in integer paise to avoid accumulated floating-point error.
    // Each amount was stored as (netPaise / 100); ROUND(amount * 100) recovers
    // the exact paise integer that the banking partner also used.
    const row = store.db
      .prepare('SELECT COUNT(*) AS n, SUM(CAST(ROUND(amount * 100) AS INTEGER)) AS paise FROM ledger WHERE user_id = ?')
      .get(userId);
    const ledgerPaise = row.paise || 0;

    const control = store.db
      .prepare('SELECT control_paise FROM control_totals WHERE user_id = ?')
      .get(userId);
    const controlPaise = control ? control.control_paise : 0;

    res.json({
      user_id: userId,
      entries: row.n,
      ledger_sum: ledgerPaise / 100,
      control_total: controlPaise / 100,
      difference: (ledgerPaise - controlPaise) / 100,
    });
  });

  return app;
}

module.exports = { build, accruedInterest, PROCESSING_FEE_RATE };
