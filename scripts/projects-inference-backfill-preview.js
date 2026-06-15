#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const {
  assertProjectsInferencePreviewAllowed,
  buildStrictSameClientPreviewSql,
  parseProjectsInferencePreviewArgs,
} = require('./projects-inference-backfill-preview-lib.js');

function main() {
  const config = parseProjectsInferencePreviewArgs(process.argv.slice(2));
  assertProjectsInferencePreviewAllowed(config);

  const sql = buildStrictSameClientPreviewSql({ limit: config.limit });
  const raw = execFileSync('docker', [
    'exec',
    'erp_test-postgresdb-1',
    'psql',
    '-U',
    'postgres',
    '-d',
    'erpdb',
    '-v',
    'ON_ERROR_STOP=1',
    '-t',
    '-A',
    '-F',
    '\t',
    '-c',
    sql,
  ], { encoding: 'utf8' });

  const rows = parseRows(raw);
  const eligible = rows.filter((row) => row.candidateProjectCount === 1);
  const conflicts = rows.filter((row) => row.candidateProjectCount > 1);
  const output = {
    generatedAt: new Date().toISOString(),
    targetEnv: config.targetEnv,
    rule: config.rule,
    summary: {
      rows: rows.length,
      eligible: eligible.length,
      conflicts: conflicts.length,
      projects: [...new Set(rows.map((row) => row.projectCode))].sort(),
    },
    eligible,
    conflicts,
  };

  mkdirSync(dirname(config.output), { recursive: true });
  writeFileSync(config.output, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(output.summary, null, 2)}\n`);
}

function parseRows(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [
        projectId,
        projectCode,
        projectName,
        clientId,
        clientName,
        orderId,
        orderName,
        orderStatusName,
        orderDate,
        confidence,
        reason,
        candidateProjectCount,
        conflictProjectCodes,
      ] = line.split('\t');
      return {
        projectId,
        projectCode,
        projectName,
        clientId,
        clientName,
        orderId,
        orderName,
        orderStatusName,
        orderDate,
        confidence,
        reason,
        candidateProjectCount: Number(candidateProjectCount),
        conflictProjectCodes,
      };
    });
}

if (require.main === module) {
  main();
}

module.exports = { parseRows };
