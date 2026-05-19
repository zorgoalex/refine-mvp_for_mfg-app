const fs = require('fs');

const ALLOWED_ENV_KEYS = new Set([
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'FRONTEND_PAGES_STAGE_CREATE_USER',
  'PAYMENTS_STAGE_ORDER_ID',
  'PAYMENTS_STAGE_ORDER_NAME',
  'PAYMENTS_STAGE_PAYMENT_TYPE_NAME',
  'PAYMENTS_STAGE_PAYMENT_DATE_UI',
  'PAYMENTS_STAGE_PAYMENT_DATE_SQL',
  'PRODUCTION_ACTIONS_STAGE_ORDER_ID',
  'PRODUCTION_ACTIONS_STAGE_ORDER_NAME',
]);

function readDotenvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  return parseDotenvFile(fs.readFileSync(filePath, 'utf8'));
}

function parseDotenvFile(content) {
  const result = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function buildStageCutoverEnv(dotenvValues, options) {
  const env = {
    PLAYWRIGHT_SKIP_WEB_SERVER: 'true',
    FRONTEND_PAGES_STAGE_CANARY: 'true',
    FRONTEND_PAGES_STAGE_FRONTEND_URL: options.frontendUrl,
    FRONTEND_PAGES_STAGE_BACKEND_API_URL: options.backendApiUrl,
    FRONTEND_PAGES_STAGE_POSTGRES_CONTAINER: options.postgresContainer,
    PAYMENTS_STAGE_CANARY: 'true',
    PAYMENTS_STAGE_FRONTEND_URL: options.frontendUrl,
    PAYMENTS_STAGE_BACKEND_API_URL: options.backendApiUrl,
    PAYMENTS_STAGE_POSTGRES_CONTAINER: options.postgresContainer,
    PRODUCTION_ACTIONS_STAGE_CANARY: 'true',
    PRODUCTION_ACTIONS_STAGE_FRONTEND_URL: options.frontendUrl,
    PRODUCTION_ACTIONS_STAGE_BACKEND_API_URL: options.backendApiUrl,
    PRODUCTION_ACTIONS_STAGE_POSTGRES_CONTAINER: options.postgresContainer,
    CLIENT_PHONES_STAGE_CANARY: 'true',
    CLIENT_PHONES_STAGE_FRONTEND_URL: options.frontendUrl,
    CLIENT_PHONES_STAGE_BACKEND_API_URL: options.backendApiUrl,
    CLIENT_PHONES_STAGE_POSTGRES_CONTAINER: options.postgresContainer,
    DEADLINE_ENGINE_STAGE_CANARY: 'true',
    DEADLINE_ENGINE_STAGE_FRONTEND_URL: options.frontendUrl,
    DEADLINE_ENGINE_STAGE_BACKEND_API_URL: options.backendApiUrl,
    DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER: options.postgresContainer,
  };

  for (const [key, value] of Object.entries(dotenvValues || {})) {
    if (ALLOWED_ENV_KEYS.has(key) && value !== '') {
      env[key] = value;
    }
  }

  return env;
}

function redactCommandForLog(command, env) {
  let redacted = String(command);
  for (const [key, value] of Object.entries(env || {})) {
    if (!/SECRET|TOKEN|PASSWORD|DATABASE_URL|API_KEY|PEPPER/i.test(key)) continue;
    if (typeof value === 'string' && value) {
      redacted = redacted.split(`${key}=${value}`).join(`${key}=[redacted]`);
      redacted = redacted.split(value).join('[redacted]');
    }
  }
  return redacted;
}

module.exports = {
  buildStageCutoverEnv,
  parseDotenvFile,
  readDotenvFile,
  redactCommandForLog,
};
