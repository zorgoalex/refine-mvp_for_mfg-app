import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// «Переделка» (plan §5.5, variant B): every write of a detail production stage by
// MDF/CNC automation must keep details of production round > 1 out
// (`production_round = 1` / `firstRoundOnly`). New writers in these modules must
// not bypass the exclusion.
const root = join(__dirname, '../../..');
const MDF_SOURCES = ['src/modules/cnc-telegram', 'src/modules/mdf-board'];
const EXTRA_FILES = ['src/modules/orders/adapters/pg-mdf-production-return.ts'];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.ts$/.test(name) && !/\.(test|spec|integration)\.ts$/.test(name) && !name.endsWith('.integration.ts') ? [path] : [];
  });
}

function stageWrites(source: string): string[] {
  const writes: string[] = [];
  const pattern = /UPDATE\s+order_details\b[\s\S]{0,400}?production_status_id\s*=/gi;
  for (const match of source.matchAll(pattern)) {
    writes.push(source.slice(Math.max(0, (match.index ?? 0) - 400), (match.index ?? 0) + 800));
  }
  return writes;
}

describe('MDF/CNC automation keeps production-round > 1 details out (§5.5)', () => {
  const files = [
    ...MDF_SOURCES.flatMap((dir) => walk(join(root, dir))),
    ...EXTRA_FILES.map((file) => join(root, file)),
  ];

  it('finds the MDF/CNC stage writers', () => {
    const writers = files.filter((file) => stageWrites(readFileSync(file, 'utf8')).length > 0);
    expect(writers.map((file) => relative(root, file)).sort()).toEqual([
      'src/modules/cnc-telegram/adapters/pg-cnc-telegram-repository.ts',
      'src/modules/mdf-board/adapters/mdf-correction-command.ts',
      'src/modules/mdf-board/application/mdf-cnc-authority-job.ts',
      'src/modules/orders/adapters/pg-mdf-production-return.ts',
    ]);
  });

  it('every such write is bounded to production round 1 (or to a pre-filtered detail list)', () => {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const write of stageWrites(source)) {
        const rel = relative(root, file);
        if (rel === 'src/modules/orders/adapters/pg-mdf-production-return.ts') {
          // The card return writes only preview details, which exclude round > 1.
          expect(source).toContain('cardDetails.filter((d) => d.productionRound === 1)');
          expect(source).toContain('MDF_RETURN_REWORK_DETAILS_MANUAL');
          continue;
        }
        expect(write, rel).toMatch(/production_round\s*=\s*1/);
      }
    }
  });

  it('readiness aggregates ignore production-round > 1 details (they neither block nor complete a card)', () => {
    const read = (file: string) => readFileSync(join(root, file), 'utf8');
    const readiness = read('src/shared/cnc-material/cut-readiness-sql.ts');
    expect(readiness).toContain('COALESCE(matched.production_round, inferred.production_round, 1) > 1 AS excluded');
    expect(readiness.match(/FILTER \(WHERE NOT item\.excluded\)/g)).toHaveLength(2);
    expect(readiness).toContain('COALESCE(detail.production_round, 1) > 1 AS excluded');
    expect(readiness).toContain('COALESCE(BOOL_AND(packed) FILTER (WHERE NOT excluded), false)');
    expect(readiness).toContain('COALESCE(BOOL_AND(COALESCE(hidden_by_rule, false)) FILTER (WHERE NOT excluded), false)');

    const events = read('src/modules/status-automation/adapters/pg-mdf-board-event-repository.ts');
    expect(events).toContain('WHERE d.delete_flag=false AND d.production_round=1');
    expect(events.match(/FILTER \(WHERE NOT m\.excluded\)/g)).toHaveLength(4);
    expect(events.match(/AND NOT i\.excluded/g)).toHaveLength(2);

    const cnc = read('src/modules/cnc-telegram/adapters/pg-cnc-telegram-repository.ts');
    expect(cnc).toContain('detail.production_round > 1 AS excluded');
    expect(cnc).toContain('const rows = result.rows.filter((row) => row.excluded !== true);');
    expect(cnc).toContain('AND details.production_round = 1');

    const actions = read('src/modules/production-actions/adapters/pg-production-action-repository.ts');
    expect(actions).toContain('WHERE NOT state.excluded AND NOT EXISTS (');
    expect(actions).toContain('AND NOT candidate.excluded');
  });

  it('MDF-sourced status automation loads first-round details only', () => {
    const source = readFileSync(join(root, 'src/modules/production-actions/adapters/pg-production-action-repository.ts'), 'utf8');
    expect(source).toContain("const mdfSourced = ctx.eventType.startsWith('mdf.') || ctx.mdfBoardScope !== undefined;");
    expect(source).toContain('{ firstRoundOnly: mdfSourced }');
    expect(source).toContain("${options.firstRoundOnly ? 'AND detail.production_round = 1' : ''}");
  });
});
