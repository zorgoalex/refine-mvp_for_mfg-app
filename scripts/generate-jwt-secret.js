#!/usr/bin/env node

/**
 * JWT Secret Generator
 *
 * Генерирует криптографически стойкие секретные ключи для JWT
 * Run: node scripts/generate-jwt-secret.js
 */

const crypto = require('crypto');

function generateSecret(length = 32) {
  return crypto.randomBytes(length).toString('base64');
}

console.log('='.repeat(80));
console.log('JWT SECRET GENERATOR');
console.log('='.repeat(80));
console.log('');
console.log('Генерация криптографически стойких ключей для JWT аутентификации');
console.log('');
console.log('='.repeat(80));
console.log('');

// Генерируем два ключа - для Access Token и Refresh Token
const jwtSecret = generateSecret(32); // 256 bits
const jwtRefreshSecret = generateSecret(32); // 256 bits

console.log('1. JWT_SECRET (для Access Token):');
console.log('   Используется в Hasura HASURA_GRAPHQL_JWT_SECRET');
console.log('   Также используется в Vercel Functions для подписи Access Token');
console.log('');
console.log(`   ${jwtSecret}`);
console.log('');
console.log('-'.repeat(80));
console.log('');

console.log('2. JWT_REFRESH_SECRET (для Refresh Token):');
console.log('   Используется только в Vercel Functions для подписи Refresh Token');
console.log('');
console.log(`   ${jwtRefreshSecret}`);
console.log('');
console.log('-'.repeat(80));
console.log('');

console.log('HASURA DOCKER-COMPOSE CONFIGURATION:');
console.log('');
console.log('Добавьте следующую переменную окружения в docker-compose.yml:');
console.log('');
console.log('environment:');
console.log('  HASURA_GRAPHQL_JWT_SECRET: |');
console.log('    {');
console.log('      "type": "HS256",');
console.log(`      "key": "${jwtSecret}"`);
console.log('    }');
console.log('');
console.log('-'.repeat(80));
console.log('');

console.log('VERCEL ENVIRONMENT VARIABLES:');
console.log('');
console.log('Добавьте следующие переменные в Vercel Dashboard:');
console.log('');
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`JWT_REFRESH_SECRET=${jwtRefreshSecret}`);
console.log('');
console.log('-'.repeat(80));
console.log('');

console.log('.ENV FILE FOR LOCAL DEVELOPMENT (Vercel Functions):');
console.log('');
console.log('Создайте файл .env.local с следующими переменными:');
console.log('');
console.log(`JWT_SECRET=${jwtSecret}`);
console.log(`JWT_REFRESH_SECRET=${jwtRefreshSecret}`);
console.log('HASURA_URL=http://localhost:8585/v1/graphql');
console.log('HASURA_ADMIN_SECRET=your_admin_secret_here');
console.log('');
console.log('='.repeat(80));
console.log('');
console.log('⚠️  ВАЖНО:');
console.log('- Сохраните эти ключи в безопасном месте');
console.log('- Никогда не коммитьте их в git');
console.log('- Используйте разные ключи для dev/staging/production');
console.log('- Периодически меняйте ключи (ротация)');
console.log('');
console.log('='.repeat(80));
