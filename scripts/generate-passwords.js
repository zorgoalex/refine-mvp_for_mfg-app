#!/usr/bin/env node

/**
 * Password Hash Generator for Test Users
 *
 * This script generates bcrypt hashes for test user passwords.
 * Run: node scripts/generate-passwords.js
 *
 * Output: SQL statements to update users table
 */

const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

// Test passwords for development (NEVER use in production!)
const testPasswords = {
  admin: 'admin123',
  manager: 'manager123',
  operator: 'operator123',
  top_manager: 'topmanager123',
  worker: 'worker123',
  viewer: 'viewer123',
};

async function generateHash(password) {
  const salt = await bcrypt.genSalt(SALT_ROUNDS);
  const hash = await bcrypt.hash(password, salt);
  return hash;
}

async function generateAllHashes() {
  console.log('='.repeat(80));
  console.log('GENERATING BCRYPT HASHES FOR TEST USERS');
  console.log('='.repeat(80));
  console.log('');
  console.log('⚠️  WARNING: These are TEST passwords for DEVELOPMENT ONLY!');
  console.log('⚠️  NEVER use these passwords in production!');
  console.log('');
  console.log('='.repeat(80));
  console.log('');

  const hashes = {};

  for (const [role, password] of Object.entries(testPasswords)) {
    const hash = await generateHash(password);
    hashes[role] = hash;

    console.log(`Role: ${role}`);
    console.log(`  Password: ${password}`);
    console.log(`  Hash: ${hash}`);
    console.log('');
  }

  console.log('='.repeat(80));
  console.log('SQL STATEMENTS TO UPDATE EXISTING USERS:');
  console.log('='.repeat(80));
  console.log('');

  // Generate SQL for updating existing users
  console.log('-- Update existing users with password hashes');
  console.log('-- Run these statements in your PostgreSQL database');
  console.log('');

  for (const [role, hash] of Object.entries(hashes)) {
    console.log(`-- Update ${role} user`);
    console.log(`UPDATE users`);
    console.log(`SET password_hash = '${hash}'`);
    console.log(`WHERE username = '${role}';`);
    console.log('');
  }

  console.log('='.repeat(80));
  console.log('SQL STATEMENTS TO CREATE NEW TEST USERS:');
  console.log('='.repeat(80));
  console.log('');

  // Role ID mapping based on schema v11.9
  const roleIdMap = {
    admin: 1,
    manager: 10,
    operator: 11,
    top_manager: 15,
    worker: 20,
    viewer: 100, // newly added viewer role
  };

  console.log('-- Create new test users (if they do not exist)');
  console.log('-- Adjust employee_id and other fields as needed');
  console.log('');

  for (const [role, hash] of Object.entries(hashes)) {
    const roleId = roleIdMap[role];
    const email = `${role}@mebelkz.local`;
    const fullName = role.charAt(0).toUpperCase() + role.slice(1) + ' User';

    console.log(`-- Create ${role} user`);
    console.log(`INSERT INTO users (`);
    console.log(`    username, email, password_hash, role_id, full_name, is_active`);
    console.log(`) VALUES (`);
    console.log(`    '${role}',`);
    console.log(`    '${email}',`);
    console.log(`    '${hash}',`);
    console.log(`    ${roleId},`);
    console.log(`    '${fullName}',`);
    console.log(`    true`);
    console.log(`)`);
    console.log(`ON CONFLICT (username) DO UPDATE SET`);
    console.log(`    password_hash = EXCLUDED.password_hash,`);
    console.log(`    email = EXCLUDED.email,`);
    console.log(`    role_id = EXCLUDED.role_id;`);
    console.log('');
  }

  console.log('='.repeat(80));
  console.log('VERIFICATION:');
  console.log('='.repeat(80));
  console.log('');
  console.log('To verify the hashes are correct, you can test with bcrypt.compare():');
  console.log('');
  console.log('const bcrypt = require("bcryptjs");');
  console.log('const isValid = await bcrypt.compare("admin123", "<hash>");');
  console.log('console.log(isValid); // should be true');
  console.log('');
}

// Run the generator
generateAllHashes().catch(console.error);
