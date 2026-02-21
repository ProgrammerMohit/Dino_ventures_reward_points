#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const fs       = require('fs');
const path     = require('path');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'wallet_service',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function seed() {
  const seedFile = path.join(__dirname, '../migrations/002_seed.sql');
  const sql      = fs.readFileSync(seedFile, 'utf8');

  console.log('\n🌱 Running seed script...\n');

  try {
    await pool.query(sql);
    console.log('✅ Seed data applied successfully.\n');

    // Print summary
    const { rows: accounts } = await pool.query(`
      SELECT a.name, at.code AS asset, ab.balance
      FROM accounts a
      JOIN asset_types at ON at.id = a.asset_type_id
      JOIN account_balances ab ON ab.account_id = a.id
      ORDER BY a.account_type, a.name
    `);

    console.log('📊 Account Summary:');
    console.log('─'.repeat(50));
    for (const row of accounts) {
      console.log(`  ${row.name.padEnd(25)} ${row.asset.padEnd(15)} ${row.balance}`);
    }
    console.log('─'.repeat(50));
    console.log();
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  }

  await pool.end();
}

seed().catch((err) => {
  console.error('Seed error:', err);
  process.exit(1);
});
