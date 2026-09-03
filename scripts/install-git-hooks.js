#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');

function isEnabled(value) {
  return ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());
}

function isCiEnvironment(env) {
  return isEnabled(env.CI) || isEnabled(env.GITHUB_ACTIONS) || isEnabled(env.VERCEL);
}

function installGitHooks({ env = process.env, run = spawnSync, exists = existsSync } = {}) {
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
  if (requiredHooks.some((hook) => !exists(hook))) {
    return { installed: false, reason: 'hooks-not-found' };
  }

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
  const result = installGitHooks();
  if (result.installed) {
    console.log('Git hooks enabled from .githooks');
  }
}

module.exports = { installGitHooks, isCiEnvironment };
