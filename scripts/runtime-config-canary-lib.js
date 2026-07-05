const fs = require('fs');
const path = require('path');

const ROLLOUT_FEATURE_KEYS = [
  'backendAuth',
  'backendPermissions',
  'backendOrdersRead',
  'backendOrdersWrite',
  'backendPayments',
  'backendClientPhones',
  'backendProductionActions',
  'backendDeadlines',
  'backendOrderExport',
  'backendUsers',
  'backendVlm',
  'backendReferences',
  'labels',
  'workosAuth',
];

const STATIC_FEATURE_EXPECTATIONS = {
  enableLegacyHasura: true,
};

const FEATURE_KEYS = [
  ...ROLLOUT_FEATURE_KEYS,
  'enableLegacyHasura',
];

const STAGED_CANARY_FILES = [
  { file: '00-all-off.json', enabled: [] },
  { file: '01-backend-auth.json', enabled: ['backendAuth'] },
  { file: '02-backend-permissions.json', enabled: ['backendAuth', 'backendPermissions'] },
  {
    file: '03-orders-read.json',
    enabled: ['backendAuth', 'backendPermissions', 'backendOrdersRead'],
  },
  {
    file: '04-orders-write.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
    ],
  },
  {
    file: '05-order-export.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendOrderExport',
    ],
  },
  {
    file: '06-users.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendOrderExport',
      'backendUsers',
    ],
  },
  {
    file: '07-vlm.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendOrderExport',
      'backendUsers',
      'backendVlm',
    ],
  },
  {
    file: '08-payments.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendPayments',
      'backendOrderExport',
      'backendUsers',
      'backendVlm',
    ],
  },
  {
    file: '09-production-actions.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendPayments',
      'backendProductionActions',
      'backendOrderExport',
      'backendUsers',
      'backendVlm',
    ],
  },
  {
    file: '10-client-phones.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendPayments',
      'backendClientPhones',
      'backendProductionActions',
      'backendOrderExport',
      'backendUsers',
      'backendVlm',
    ],
  },
  {
    file: '11-deadlines.json',
    enabled: [
      'backendAuth',
      'backendPermissions',
      'backendOrdersRead',
      'backendOrdersWrite',
      'backendPayments',
      'backendClientPhones',
      'backendProductionActions',
      'backendDeadlines',
      'backendOrderExport',
      'backendUsers',
      'backendVlm',
    ],
  },
  { file: '99-rollback-all-off.json', enabled: [] },
];

const SECRET_LIKE_KEY = /(secret|password|token|pepper|api[_-]?key|client[_-]?secret|authorization|database[_-]?url|auth0|gas)/i;

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getTrueFeatures(config) {
  const features = config && typeof config === 'object' ? config.features : null;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return [];

  return ROLLOUT_FEATURE_KEYS.filter((key) => features[key] === true);
}

function validateRuntimeConfig(config, options = {}) {
  const errors = [];
  const label = options.label || 'runtime config';
  const expectedEnabled = options.expectedEnabled;
  const requireCompleteFeatures = options.requireCompleteFeatures !== false;

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return [`${label}: config must be an object`];
  }

  if (config.apiUrl !== undefined && config.apiUrl !== null && typeof config.apiUrl !== 'string') {
    errors.push(`${label}: apiUrl must be a string, null, or omitted`);
  }

  const features = config.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    errors.push(`${label}: features must be an object`);
    return errors;
  }

  if (requireCompleteFeatures) {
    for (const key of FEATURE_KEYS) {
      if (!(key in features)) {
        errors.push(`${label}: missing features.${key}`);
      }
    }
  }

  for (const key of Object.keys(features)) {
    if (!FEATURE_KEYS.includes(key)) {
      errors.push(`${label}: unknown features.${key}`);
      continue;
    }

    if (typeof features[key] !== 'boolean') {
      errors.push(`${label}: features.${key} must be boolean`);
    }
  }

  errors.push(...validateFeatureDependencies(features, label));
  errors.push(...validateNoSecretLikeKeys(config, label));

  if (expectedEnabled) {
    const expected = new Set(expectedEnabled);
    for (const key of ROLLOUT_FEATURE_KEYS) {
      const actual = features[key] === true;
      const wanted = expected.has(key);
      if (actual !== wanted) {
        errors.push(`${label}: expected features.${key}=${wanted}, got ${actual}`);
      }
    }
  }

  return errors;
}

function validateFeatureDependencies(features, label) {
  const errors = [];

  if (features.backendPermissions === true && features.backendAuth !== true) {
    errors.push(`${label}: backendPermissions requires backendAuth`);
  }

  if (features.backendOrdersRead === true && features.backendAuth !== true) {
    errors.push(`${label}: backendOrdersRead requires backendAuth`);
  }

  if (features.backendOrdersWrite === true && features.backendOrdersRead !== true) {
    errors.push(`${label}: backendOrdersWrite requires backendOrdersRead`);
  }

  if (features.backendPayments === true && features.backendPermissions !== true) {
    errors.push(`${label}: backendPayments requires backendPermissions`);
  }

  if (features.backendProductionActions === true && features.backendPayments !== true) {
    errors.push(`${label}: backendProductionActions requires backendPayments`);
  }

  if (features.backendClientPhones === true && features.backendProductionActions !== true) {
    errors.push(`${label}: backendClientPhones requires backendProductionActions`);
  }

  if (features.backendDeadlines === true && features.backendAuth !== true) {
    errors.push(`${label}: backendDeadlines requires backendAuth`);
  }

  if (features.backendDeadlines === true && features.backendOrdersRead !== true) {
    errors.push(`${label}: backendDeadlines requires backendOrdersRead`);
  }

  if (features.backendOrderExport === true && features.backendOrdersRead !== true) {
    errors.push(`${label}: backendOrderExport requires backendOrdersRead`);
  }

  if (features.backendUsers === true && features.backendPermissions !== true) {
    errors.push(`${label}: backendUsers requires backendPermissions`);
  }

  if (features.backendVlm === true && features.backendPermissions !== true) {
    errors.push(`${label}: backendVlm requires backendPermissions`);
  }

  return errors;
}

function validateNoSecretLikeKeys(value, label, pathParts = []) {
  const errors = [];

  if (!value || typeof value !== 'object') return errors;

  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...pathParts, key];
    if (SECRET_LIKE_KEY.test(key)) {
      errors.push(`${label}: secret-like key is not allowed: ${nextPath.join('.')}`);
    }
    errors.push(...validateNoSecretLikeKeys(child, label, nextPath));
  }

  return errors;
}

function validateStagedCanaryDirectory(directory) {
  const errors = [];
  const seenFiles = new Set();

  for (const stage of STAGED_CANARY_FILES) {
    const filePath = path.join(directory, stage.file);
    seenFiles.add(stage.file);

    if (!fs.existsSync(filePath)) {
      errors.push(`${stage.file}: missing staged canary example`);
      continue;
    }

    let config;
    try {
      config = readJsonFile(filePath);
    } catch (error) {
      errors.push(`${stage.file}: invalid JSON (${error.message})`);
      continue;
    }

    errors.push(
      ...validateRuntimeConfig(config, {
        label: stage.file,
        expectedEnabled: stage.enabled,
      }),
    );
    errors.push(...validateStaticFeatureExpectations(config, stage.file));
  }

  const actualFiles = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort();
  for (const file of actualFiles) {
    if (!seenFiles.has(file)) {
      errors.push(`${file}: unexpected staged canary JSON file`);
    }
  }

  return errors;
}

function validateStaticFeatureExpectations(config, label) {
  const errors = [];
  const features = (config && config.features) || {};

  for (const [key, wanted] of Object.entries(STATIC_FEATURE_EXPECTATIONS)) {
    const actual = features[key];
    if (actual !== wanted) {
      errors.push(`${label}: expected features.${key}=${wanted}, got ${actual}`);
    }
  }

  return errors;
}

function compareRuntimeConfigFeatures(actualConfig, expectedConfig, label = 'runtime config') {
  const errors = [];
  const actualFeatures = (actualConfig && actualConfig.features) || {};
  const expectedFeatures = (expectedConfig && expectedConfig.features) || {};

  for (const key of FEATURE_KEYS) {
    if (actualFeatures[key] !== expectedFeatures[key]) {
      errors.push(
        `${label}: features.${key} expected ${expectedFeatures[key]}, got ${actualFeatures[key]}`,
      );
    }
  }

  return errors;
}

function formatEnabledFeatures(config) {
  const enabled = getTrueFeatures(config);
  return enabled.length > 0 ? enabled.join(', ') : 'none';
}

module.exports = {
  FEATURE_KEYS,
  STAGED_CANARY_FILES,
  compareRuntimeConfigFeatures,
  formatEnabledFeatures,
  getTrueFeatures,
  readJsonFile,
  validateRuntimeConfig,
  validateStagedCanaryDirectory,
};
