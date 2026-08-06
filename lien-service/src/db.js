'use strict';
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(process.env.DB_PATH || ':memory:');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    wallet_balance REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    principal REAL NOT NULL,
    annual_rate REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'approved'
  );

  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    loan_id INTEGER,
    kind TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Simulates network latency to the core banking partner. Do not remove.
const LATENCY_MS = Number(process.env.PARTNER_LATENCY_MS || 6);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWalletBalance(userId) {
  await wait(LATENCY_MS);
  const row = db.prepare('SELECT wallet_balance FROM users WHERE id = ?').get(userId);
  return row ? row.wallet_balance : null;
}

async function setWalletBalance(userId, balance) {
  await wait(LATENCY_MS);
  db.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').run(balance, userId);
}

async function getLoan(loanId) {
  await wait(LATENCY_MS);
  return db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
}

async function appendLedger(entry) {
  await wait(LATENCY_MS);
  db.prepare(
    'INSERT INTO ledger (user_id, loan_id, kind, amount, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(entry.user_id, entry.loan_id, entry.kind, entry.amount, entry.created_at);
}

function countLedger(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE user_id = ?').get(userId).n;
}

function pageLedger(userId, page, limit) {
  return db
    .prepare(
      'SELECT id, kind, amount, created_at FROM ledger WHERE user_id = ? ORDER BY id ASC LIMIT ? OFFSET ?'
    )
    .all(userId, limit, (page - 1) * limit);
}

function allLedger(userId) {
  return db
    .prepare('SELECT id, kind, amount, created_at FROM ledger WHERE user_id = ? ORDER BY id ASC')
    .all(userId);
}

// Atomically transition status from approved to disbursed
function markLoanDisbursed(loanId) {
  const result = db
    .prepare("UPDATE loans SET status = 'disbursed' WHERE id = ? AND status = 'approved'")
    .run(loanId);
  return result.changes;
}

function reset() {
  db.exec('DELETE FROM ledger; DELETE FROM loans; DELETE FROM users;');
  db.exec("DELETE FROM sqlite_sequence WHERE name = 'ledger';");
}

module.exports = {
  db,
  getWalletBalance,
  setWalletBalance,
  getLoan,
  markLoanDisbursed,
  appendLedger,
  countLedger,
  pageLedger,
  allLedger,
  reset,
};
