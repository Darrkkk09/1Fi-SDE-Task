'use strict';
const store = require('./db');

/**
 * Deterministic seed. `control_totals` holds the figure our banking partner
 * reports, computed in integer paise, which is the source of truth.
 */
function seed({ users = 3, disbursalsPerUser = 420 } = {}) {
  store.reset();
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS control_totals (
      user_id INTEGER PRIMARY KEY,
      control_paise INTEGER NOT NULL
    );
  `);
  store.db.exec('DELETE FROM control_totals;');

  const insertUser = store.db.prepare('INSERT INTO users (id, name, wallet_balance) VALUES (?, ?, 0)');
  const insertLoan = store.db.prepare(
    'INSERT INTO loans (id, user_id, principal, annual_rate, status) VALUES (?, ?, ?, ?, ?)'
  );
  const insertLedger = store.db.prepare(
    'INSERT INTO ledger (user_id, loan_id, kind, amount, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertControl = store.db.prepare(
    'INSERT INTO control_totals (user_id, control_paise) VALUES (?, ?)'
  );

  // Small LCG so the dataset is identical on every machine.
  let s = 20260803;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);

  let loanId = 1000;
  for (let u = 1; u <= users; u++) {
    insertUser.run(u, `Borrower ${u}`);
    let controlPaise = 0;

    for (let i = 0; i < disbursalsPerUser; i++) {
      // Lien amounts follow the redeemable value of the pledged units, so
      // they are rarely round numbers.
      const principal = Math.round((25000 + rnd() * 475000) * 100) / 100;
      insertLoan.run(loanId, u, principal, 0.135, 'disbursed');

      // Partner computes in integer paise and rounds half-up per transaction.
      const principalPaise = Math.round(principal * 100);
      const feePaise = Math.round(principalPaise * 175 / 10000);
      const netPaise = principalPaise - feePaise;
      controlPaise += netPaise;

      // Store the ledger amount in the same unit (paise → rupees) so that
      // the daily-close sum matches the banking partner's figure exactly.
      const net = netPaise / 100;
      const ts = new Date(Date.UTC(2026, 6, 1 + (i % 28), 4, i % 60, 0)).toISOString();
      insertLedger.run(u, loanId, 'disbursal', net, ts);
      loanId++;
    }

    insertControl.run(u, controlPaise);
    // Two approved-but-undisbursed loans per user, for the disbursal endpoint.
    insertLoan.run(loanId++, u, 100000, 0.135, 'approved');
    insertLoan.run(loanId++, u, 250000, 0.135, 'approved');
  }
}

module.exports = { seed };

if (require.main === module) {
  seed();
  const n = store.db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n;
  console.log(`seeded ${n} ledger entries`);
}
