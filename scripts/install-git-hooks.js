#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { accessSync, constants, existsSync, statSync } = require('node:fs');

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());
}

function isCiEnvironment(env) {
  return isEnabled(env.CI) || isEnabled(env.GITHUB_ACTIONS) || isEnabled(env.VERCEL);
}

function installGitHooks({ env = process.env, run = spawnSync, exists = existsSync, access = accessSync, stat = statSync } = {}) {
  if (isCiEnvironment(env)) {
    return { installed: false, reason: 'ci' };
  }

  const insideWorktree = run('git', ['rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (insideWorktree.status !== 0 || insideWorktree.stdout.trim() !== 'true') {
    return { installed: false, reason: 'not-a-git-worktree' };
  }

  const requiredHooks = ['.githooks/pre-commit', '.githooks/pre-push'];
  const runner = '.githooks/run-heavy.sh';
  for (const file of [...requiredHooks, runner]) {
    if (!exists(file)) throw new Error(`Required Git hook file is missing: ${file}`);
    if (!stat(file).isFile()) throw new Error(`Git hook path must be a regular file: ${file}`);
  }
  for (const hook of requiredHooks) {
    try { access(hook, constants.R_OK | constants.X_OK); }
    catch { throw new Error(`Git hook must be readable and executable: ${hook}`); }
  }
  try { access(runner, constants.R_OK); }
  catch { throw new Error(`Git hook runner must be readable: ${runner}`); }

  const configured = run('git', ['config', 'core.hooksPath', '.githooks'], {
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (configured.status !== 0) {
    throw new Error('Failed to configure core.hooksPath');
  }

  return { installed: true };
}

if (require.main === module) {
  try {
    const result = installGitHooks();
    if (result.installed) console.log('Git hooks enabled from .githooks (resource guard required by default)');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { installGitHooks, isCiEnvironment };
