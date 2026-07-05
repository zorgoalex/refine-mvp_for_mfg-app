#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname } = require('node:path');
const {
  assertGroupsInferencePreviewAllowed,
  buildStrictSameClientPreviewSql,
  parseGroupsInferencePreviewArgs,
} = require('./groups-inference-backfill-preview-lib.js');

function main() {
  const config = parseGroupsInferencePreviewArgs(process.argv.slice(2));
  assertGroupsInferencePreviewAllowed(config);

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
  const eligible = rows.filter((row) => row.candidateGroupCount === 1);
  const conflicts = rows.filter((row) => row.candidateGroupCount > 1);
  const output = {
    generatedAt: new Date().toISOString(),
    targetEnv: config.targetEnv,
    rule: config.rule,
    summary: {
      rows: rows.length,
      eligible: eligible.length,
      conflicts: conflicts.length,
      groups: [...new Set(rows.map((row) => row.groupCode))].sort(),
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
        groupId,
        groupCode,
        groupName,
        clientId,
        clientName,
        orderId,
        orderName,
        orderStatusName,
        orderDate,
        confidence,
        reason,
        candidateGroupCount,
        conflictGroupCodes,
      ] = line.split('\t');
      return {
        groupId,
        groupCode,
        groupName,
        clientId,
        clientName,
        orderId,
        orderName,
        orderStatusName,
        orderDate,
        confidence,
        reason,
        candidateGroupCount: Number(candidateGroupCount),
        conflictGroupCodes,
      };
    });
}

if (require.main === module) {
  main();
}

module.exports = { parseRows };
