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

async function migrate() {
  const migrationsDir = path.join(__dirname, '../migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // Run in alphabetical order (001_, 002_, etc.)

  console.log(`\n📦 Running ${files.length} migration file(s)...\n`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql      = fs.readFileSync(filePath, 'utf8');

    console.log(`  ▶ Applying: ${file}`);
    try {
      await pool.query(sql);
      console.log(`  ✅ Done: ${file}\n`);
    } catch (err) {
      console.error(`  ❌ Failed: ${file}`);
      console.error(`     Error:  ${err.message}\n`);
      process.exit(1);
    }
  }

  console.log('✅ All migrations applied successfully.\n');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
