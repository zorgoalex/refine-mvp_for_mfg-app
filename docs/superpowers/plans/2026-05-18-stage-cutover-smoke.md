# Stage/Cutover Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a repeatable stage/cutover smoke package that proves the current backend stage1 runtime is acceptable on the deployed `app-test`/`backend-test` environment without merging off `feat/backend-erp-stage1`.

**Architecture:** Add a small Node orchestrator that safely loads only named smoke env values from `/home/ovhtest/projects/erp_dev/.env`, runs existing runtime-config/staging/canary checks in a fixed order, and writes no secrets to stdout. Keep business-flow checks in the existing Playwright canary specs; this plan only composes them and records evidence.

**Tech Stack:** Node scripts, npm scripts, Playwright 1.56, Vitest 4, existing `scripts/smoke-*.js`, existing stage canary specs, Markdown evidence docs.

---

## Context And Boundaries

- Branch stays `feat/backend-erp-stage1`; do not merge into a parent branch.
- `CONTEXT.md` and `TODO.md` say full PRD acceptance still needs stage/cutover smoke for runtime config, Redis readiness, legacy Vercel production-disable, and backend-owned writes without Hasura fallback.
- Project-level secrets may live in `/home/ovhtest/projects/erp_dev/.env`. Never print this file, never print raw env, and never echo secret values.
- Existing stage URLs from current evidence:
  - frontend: `https://app-test.mebelkz.app`
  - backend API: `https://backend-test.mebelkz.app/api/v1`
  - backend health base: `https://backend-test.mebelkz.app`
  - postgres container: `erp_test-postgresdb-1`
- Keep Hasura as retained read/report/reference layer. The smoke only forbids backend-owned write fallbacks to Hasura.

## File Structure

- Create `scripts/stage-cutover-smoke.js`: orchestrates runtime-config, staging gates, frontend pages, payments, production actions, client phones, deadline canary, and final local regression checks.
- Create `scripts/stage-cutover-smoke-lib.js`: pure helpers for env-file parsing, secret-key filtering, command construction, and redacted command logging.
- Create `src/config/stageCutoverSmoke.test.ts`: Vitest coverage for the helper behavior without hitting network or printing secrets.
- Modify `package.json`: add `smoke:stage-cutover`.
- Create `docs/stage-cutover-smoke-2026-05-18.md`: evidence template and final run log.
- Modify `/home/ovhtest/projects/erp_dev/CONTEXT.md` and `/home/ovhtest/projects/erp_dev/TODO.md` only after smoke evidence is collected. These files are outside `repo_erp`; update them manually but do not expect them in the git commit.

---

### Task 1: Stage Smoke Helper Library

**Files:**
- Create: `scripts/stage-cutover-smoke-lib.js`
- Test: `src/config/stageCutoverSmoke.test.ts`

- [ ] **Step 1: Write the failing helper tests**

Add this new test file:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildStageCutoverEnv,
  parseDotenvFile,
  redactCommandForLog,
} from '../../scripts/stage-cutover-smoke-lib.js';

describe('stage cutover smoke helpers', () => {
  it('loads only allowlisted env values and keeps secrets available without logging them', () => {
    const parsed = parseDotenvFile([
      'VERCEL_AUTOMATION_BYPASS_SECRET=secret-value',
      'FRONTEND_PAGES_STAGE_CREATE_USER=true',
      'DATABASE_URL=postgres://must-not-load',
      'UNRELATED=value',
    ].join('\n'));

    const env = buildStageCutoverEnv(parsed, {
      frontendUrl: 'https://app-test.mebelkz.app',
      backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
      backendBaseUrl: 'https://backend-test.mebelkz.app',
      postgresContainer: 'erp_test-postgresdb-1',
    });

    expect(env.VERCEL_AUTOMATION_BYPASS_SECRET).toBe('secret-value');
    expect(env.FRONTEND_PAGES_STAGE_CREATE_USER).toBe('true');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.UNRELATED).toBeUndefined();
    expect(env.FRONTEND_PAGES_STAGE_FRONTEND_URL).toBe('https://app-test.mebelkz.app');
    expect(env.FRONTEND_PAGES_STAGE_BACKEND_API_URL).toBe('https://backend-test.mebelkz.app/api/v1');
    expect(env.PLAYWRIGHT_SKIP_WEB_SERVER).toBe('true');
  });

  it('redacts known secret values from logged commands', () => {
    const text = redactCommandForLog(
      'VERCEL_AUTOMATION_BYPASS_SECRET=secret-value npm run smoke:staging-gates',
      { VERCEL_AUTOMATION_BYPASS_SECRET: 'secret-value' },
    );

    expect(text).toContain('VERCEL_AUTOMATION_BYPASS_SECRET=[redacted]');
    expect(text).not.toContain('secret-value');
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm test -- src/config/stageCutoverSmoke.test.ts
```

Expected: FAIL because `scripts/stage-cutover-smoke-lib.js` does not exist.

- [ ] **Step 3: Implement the helper library**

Create `scripts/stage-cutover-smoke-lib.js`:

```js
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
    PRODUCTION_ACTIONS_STAGE_CANARY: 'true',
    PRODUCTION_ACTIONS_STAGE_FRONTEND_URL: options.frontendUrl,
    PRODUCTION_ACTIONS_STAGE_BACKEND_API_URL: options.backendApiUrl,
    CLIENT_PHONES_STAGE_CANARY: 'true',
    CLIENT_PHONES_STAGE_FRONTEND_URL: options.frontendUrl,
    CLIENT_PHONES_STAGE_BACKEND_API_URL: options.backendApiUrl,
    DEADLINE_ENGINE_STAGE_CANARY: 'true',
    DEADLINE_ENGINE_STAGE_FRONTEND_URL: options.frontendUrl,
    DEADLINE_ENGINE_STAGE_BACKEND_API_URL: options.backendApiUrl,
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
```

- [ ] **Step 4: Run helper tests to verify GREEN**

Run:

```bash
npm test -- src/config/stageCutoverSmoke.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/stage-cutover-smoke-lib.js src/config/stageCutoverSmoke.test.ts
git commit -m "test: add stage cutover smoke env helpers"
```

---

### Task 2: Stage Cutover Smoke Orchestrator

**Files:**
- Create: `scripts/stage-cutover-smoke.js`
- Modify: `package.json`
- Test: `src/config/stageCutoverSmoke.test.ts`

- [ ] **Step 1: Add failing command-construction tests**

Append to `src/config/stageCutoverSmoke.test.ts`:

```ts
import { buildStageCutoverCommands } from '../../scripts/stage-cutover-smoke.js';

describe('stage cutover smoke command plan', () => {
  it('runs gates before mutating canaries and local regression last', () => {
    const commands = buildStageCutoverCommands({
      frontendUrl: 'https://app-test.mebelkz.app',
      backendBaseUrl: 'https://backend-test.mebelkz.app',
      backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
    }).map((command) => command.label);

    expect(commands).toEqual([
      'runtime config all-on expectation',
      'staging runtime and health gates',
      'frontend pages stage canary',
      'payments stage canary',
      'production actions stage canary',
      'client phones stage canary',
      'deadline engine stage canary',
      'local cutover regression specs',
      'unit regression suite',
      'production build',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm test -- src/config/stageCutoverSmoke.test.ts
```

Expected: FAIL because `buildStageCutoverCommands` is not implemented.

- [ ] **Step 3: Implement the orchestrator**

Create `scripts/stage-cutover-smoke.js`:

```js
#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  buildStageCutoverEnv,
  readDotenvFile,
  redactCommandForLog,
} = require('./stage-cutover-smoke-lib');

function buildStageCutoverCommands(options) {
  const runtimeUrl = `${options.frontendUrl}/runtime-config.json`;
  return [
    {
      label: 'runtime config all-on expectation',
      command: 'npm',
      args: [
        'run',
        'smoke:runtime-config',
        '--',
        '--url',
        runtimeUrl,
        '--expect',
        'docs/runtime-config/canary/11-deadlines.json',
      ],
    },
    {
      label: 'staging runtime and health gates',
      command: 'npm',
      args: [
        'run',
        'smoke:staging-gates',
        '--',
        '--frontend-url',
        options.frontendUrl,
        '--backend-url',
        options.backendBaseUrl,
        '--expect',
        'docs/runtime-config/canary/11-deadlines.json',
      ],
    },
    {
      label: 'frontend pages stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:frontend-pages-stage-canary'],
    },
    {
      label: 'payments stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:payments-stage-canary'],
    },
    {
      label: 'production actions stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:production-actions-stage-canary'],
    },
    {
      label: 'client phones stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:client-phones-stage-canary'],
    },
    {
      label: 'deadline engine stage canary',
      command: 'npm',
      args: ['run', 'test:e2e:deadline-engine-stage-canary'],
    },
    {
      label: 'local cutover regression specs',
      command: 'npx',
      args: [
        'playwright',
        'test',
        'tests/users-backend-cutover.spec.ts',
        'tests/order-export-backend-cutover.spec.ts',
        'tests/vlm-backend-cutover.spec.ts',
        'tests/payments-backend-cutover.spec.ts',
        'tests/production-actions-backend-cutover.spec.ts',
        'tests/order-save-backend-command-boundary.spec.ts',
        '--project=chromium',
      ],
    },
    {
      label: 'unit regression suite',
      command: 'npm',
      args: ['test'],
    },
    {
      label: 'production build',
      command: 'npm',
      args: ['run', 'build'],
    },
  ];
}

function parseArgs(rawArgs) {
  const options = {
    frontendUrl: 'https://app-test.mebelkz.app',
    backendBaseUrl: 'https://backend-test.mebelkz.app',
    backendApiUrl: 'https://backend-test.mebelkz.app/api/v1',
    postgresContainer: 'erp_test-postgresdb-1',
    envFile: '/home/ovhtest/projects/erp_dev/.env',
    dryRun: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    const readValue = () => rawArgs[++index];
    if (arg === '--frontend-url') options.frontendUrl = readValue();
    else if (arg.startsWith('--frontend-url=')) options.frontendUrl = arg.slice(15);
    else if (arg === '--backend-base-url') options.backendBaseUrl = readValue();
    else if (arg.startsWith('--backend-base-url=')) options.backendBaseUrl = arg.slice(19);
    else if (arg === '--backend-api-url') options.backendApiUrl = readValue();
    else if (arg.startsWith('--backend-api-url=')) options.backendApiUrl = arg.slice(18);
    else if (arg === '--postgres-container') options.postgresContainer = readValue();
    else if (arg.startsWith('--postgres-container=')) options.postgresContainer = arg.slice(21);
    else if (arg === '--env-file') options.envFile = readValue();
    else if (arg.startsWith('--env-file=')) options.envFile = arg.slice(11);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') usageAndExit(0);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  for (const key of ['frontendUrl', 'backendBaseUrl', 'backendApiUrl', 'postgresContainer']) {
    if (!options[key]) throw new Error(`Missing ${key}`);
  }

  options.frontendUrl = trimTrailingSlash(options.frontendUrl);
  options.backendBaseUrl = trimTrailingSlash(options.backendBaseUrl);
  options.backendApiUrl = trimTrailingSlash(options.backendApiUrl);
  return options;
}

function run(options) {
  const dotenvValues = readDotenvFile(options.envFile);
  const childEnv = {
    ...process.env,
    ...buildStageCutoverEnv(dotenvValues, options),
  };
  const commands = buildStageCutoverCommands(options);

  for (const step of commands) {
    const printable = redactCommandForLog(`${step.command} ${step.args.join(' ')}`, childEnv);
    console.log(`\n== ${step.label} ==`);
    console.log(printable);
    if (options.dryRun) continue;
    const result = spawnSync(step.command, step.args, {
      cwd: path.resolve(__dirname, '..'),
      env: childEnv,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Error(`${step.label} failed with exit code ${result.status}`);
    }
  }
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function usageAndExit(code = 1) {
  console.error([
    'Usage:',
    '  node scripts/stage-cutover-smoke.js [options]',
    '',
    'Options:',
    '  --frontend-url https://app-test.mebelkz.app',
    '  --backend-base-url https://backend-test.mebelkz.app',
    '  --backend-api-url https://backend-test.mebelkz.app/api/v1',
    '  --postgres-container erp_test-postgresdb-1',
    '  --env-file /home/ovhtest/projects/erp_dev/.env',
    '  --dry-run',
  ].join('\n'));
  process.exit(code);
}

if (require.main === module) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`Stage cutover smoke failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  buildStageCutoverCommands,
  parseArgs,
  run,
};
```

- [ ] **Step 4: Add npm script**

Modify `package.json` scripts:

```json
"smoke:stage-cutover": "node scripts/stage-cutover-smoke.js"
```

Place it after `smoke:staging-gates`.

- [ ] **Step 5: Run tests and dry-run**

Run:

```bash
npm test -- src/config/stageCutoverSmoke.test.ts
npm run smoke:stage-cutover -- --dry-run
```

Expected:
- Vitest PASS.
- Dry-run prints labels and commands.
- No secret values from `/home/ovhtest/projects/erp_dev/.env` appear in output.

- [ ] **Step 6: Commit**

```bash
git add scripts/stage-cutover-smoke.js package.json src/config/stageCutoverSmoke.test.ts
git commit -m "test: orchestrate stage cutover smoke"
```

---

### Task 3: Stage Evidence Document

**Files:**
- Create: `docs/stage-cutover-smoke-2026-05-18.md`

- [ ] **Step 1: Create the evidence template**

Create `docs/stage-cutover-smoke-2026-05-18.md`:

```md
# Stage/Cutover Smoke Evidence - 2026-05-18

## Scope

- Branch: `feat/backend-erp-stage1`
- Frontend: `https://app-test.mebelkz.app`
- Backend: `https://backend-test.mebelkz.app`
- Backend API: `https://backend-test.mebelkz.app/api/v1`
- Env file: `/home/ovhtest/projects/erp_dev/.env` loaded only through allowlisted smoke keys; secrets were not printed.

## Acceptance Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Runtime config matches `docs/runtime-config/canary/11-deadlines.json` | Not run | Run `npm run smoke:runtime-config -- --url=https://app-test.mebelkz.app/runtime-config.json --expect=docs/runtime-config/canary/11-deadlines.json`. |
| Backend `/health/live` and `/health/ready` pass with DB/Redis/config ready | Not run | Run through `npm run smoke:staging-gates`. |
| Legacy Vercel production-disable does not break `/runtime-config.json` | Not run | Runtime config smoke passes; optional legacy endpoint probe recorded separately. |
| Frontend routes load without GraphQL/runtime errors | Not run | Run `npm run test:e2e:frontend-pages-stage-canary`. |
| Payments backend canary passes with no Hasura payment mutations | Not run | Run `npm run test:e2e:payments-stage-canary`. |
| Production actions backend canary passes with audit/outbox/idempotency | Not run | Run `npm run test:e2e:production-actions-stage-canary`. |
| Client phones backend canary passes with audit/outbox/idempotency | Not run | Run `npm run test:e2e:client-phones-stage-canary`. |
| Deadline read-only stage canary passes | Not run | Run `npm run test:e2e:deadline-engine-stage-canary`. |
| Local backend cutover regression specs pass | Not run | Run the grouped Playwright command from `scripts/stage-cutover-smoke.js`. |
| `npm test` passes | Not run | Record file/test counts. |
| `npm run build` passes | Not run | Record existing Vite large chunk warning if still present. |

## Command Log

```bash
npm run smoke:stage-cutover
```

Result: Not run yet.

## Follow-Ups

- No follow-ups recorded before the smoke run.
```

- [ ] **Step 2: Commit**

```bash
git add docs/stage-cutover-smoke-2026-05-18.md
git commit -m "docs: add stage cutover smoke evidence template"
```

---

### Task 4: Execute Stage/Cutover Smoke

**Files:**
- Modify: `docs/stage-cutover-smoke-2026-05-18.md`

- [ ] **Step 1: Confirm protected env key exists without printing it**

Run:

```bash
grep -q '^VERCEL_AUTOMATION_BYPASS_SECRET=' /home/ovhtest/projects/erp_dev/.env && echo 'Vercel bypass env key present'
```

Expected: prints only `Vercel bypass env key present`.

- [ ] **Step 2: Run the full orchestrated smoke**

Run:

```bash
npm run smoke:stage-cutover
```

Expected:
- Runtime config smoke passes against `11-deadlines.json`.
- Staging health gates pass.
- Frontend pages, payments, production actions, client phones, and deadline stage canaries pass.
- Local cutover regression specs pass.
- `npm test` passes.
- `npm run build` passes with only the existing Vite large chunk warning if still present.

- [ ] **Step 3: If a gate fails, stop and classify before fixing**

Use this classification in the evidence doc:

```md
| Gate | Status | Evidence |
| --- | --- | --- |
| <gate name> | Fail | `<command>` failed with `<short error>`. Classified as runtime config / backend deploy drift / DB fixture / code regression / flaky browser. No later gates were claimed. |
```

Do not continue to later gates after a backend deploy drift or runtime-config mismatch until the environment is corrected.

- [ ] **Step 4: Update evidence with exact results**

Replace `Not run` rows in `docs/stage-cutover-smoke-2026-05-18.md` with concrete command outputs. Use this format:

```md
| Runtime config matches `docs/runtime-config/canary/11-deadlines.json` | Pass | `npm run smoke:runtime-config -- --url=https://app-test.mebelkz.app/runtime-config.json --expect=docs/runtime-config/canary/11-deadlines.json` exited 0 and printed enabled features without config body. |
```

Do not paste secrets, tokens, raw env, full cookies, database URLs, or full runtime config bodies.

- [ ] **Step 5: Commit evidence**

```bash
git add docs/stage-cutover-smoke-2026-05-18.md
git commit -m "docs: record stage cutover smoke evidence"
```

---

### Task 5: Update Operational Context

**Files:**
- Modify: `/home/ovhtest/projects/erp_dev/CONTEXT.md`
- Modify: `/home/ovhtest/projects/erp_dev/TODO.md`

- [ ] **Step 1: Update `CONTEXT.md` after successful smoke**

Add this dated entry near the recent backend acceptance history:

```md
### Обновление (18.05.2026) — Stage/cutover smoke backend stage1

Stage/cutover smoke на `app-test`/`backend-test` прошел для текущего
`feat/backend-erp-stage1`: runtime-config соответствует
`docs/runtime-config/canary/11-deadlines.json`, backend `/health/live` и
`/health/ready` прошли с DB/Redis/config ready, frontend pages stage canary,
payments, production actions, client phones и Deadline Engine stage canaries
прошли, local backend cutover regression specs прошли. `npm test` и
`npm run build` прошли; build сохраняет существующий Vite large chunk warning.
Evidence: `repo_erp/docs/stage-cutover-smoke-2026-05-18.md`.
```

If smoke failed, write a failure entry instead with the failed gate and do not claim acceptance.

- [ ] **Step 2: Update `TODO.md` acceptance debt**

In the highest-priority PRD acceptance section, change the relevant stage/cutover smoke debt from “ждёт stage/cutover smoke” to a dated result. Use:

```md
- Stage/cutover smoke для текущего backend stage1 выполнен 2026-05-18 на
  `app-test`/`backend-test`; evidence:
  `repo_erp/docs/stage-cutover-smoke-2026-05-18.md`. Оставшиеся acceptance
  задачи: Deadline Engine worker/actions ownership и OpenAPI/Swagger parity.
```

If smoke failed, add the failed gate as a blocker under Highest priority.

- [ ] **Step 3: Do not stage external context files**

Run from `repo_erp`:

```bash
git status --short
```

Expected: `../CONTEXT.md` and `../TODO.md` do not appear because they are outside the repo. Only commit files inside `repo_erp`.

---

### Task 6: Final Verification And Push

**Files:**
- No new files unless a previous gate required a fix.

- [ ] **Step 1: Verify git status**

Run:

```bash
git status -sb
```

Expected:
- branch is `feat/backend-erp-stage1`;
- branch may be ahead of origin;
- only known untracked `session-handoffs/*.md` remain untracked;
- no unintended files are staged.

- [ ] **Step 2: Run final minimal verification if the full smoke already passed**

Run:

```bash
npm test -- src/config/stageCutoverSmoke.test.ts
```

Expected: PASS.

Do not rerun the full smoke unless code or runtime changed after Task 4.

- [ ] **Step 3: Push current branch**

Run:

```bash
git push origin feat/backend-erp-stage1
```

Expected: branch updates on origin. Do not create a PR and do not merge.

---

## Self-Review

- Spec coverage: plan covers `CONTEXT.md` and `TODO.md` requirements for runtime-config smoke, Redis/backend readiness, legacy production-disable boundary, backend-owned write canaries, Hasura no-mutation checks, local regression, docs evidence, and operational context updates.
- Placeholder scan: no `TBD`/`TODO` placeholders remain in implementation steps; evidence template uses `Not run` rows that are explicitly replaced during Task 4.
- Type consistency: helper names used by tests match exports in `scripts/stage-cutover-smoke-lib.js` and `scripts/stage-cutover-smoke.js`.
