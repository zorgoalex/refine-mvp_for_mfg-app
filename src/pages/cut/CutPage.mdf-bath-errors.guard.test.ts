import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8');

/**
 * Source-text guard (CutPage.tsx has no FE tsconfig/jsdom harness — repo
 * convention is pure-helper unit tests + these guards, see AGENTS memory).
 * Verifies the four write call sites that can now surface the MDF-bath
 * lifecycle 409/428 codes (make-current, delete/archive, manual-layout save,
 * calculate) route the error through buildMdfBathErrorView and reload the
 * job when the view says to, and that a blocked calculate retarget warns.
 */
describe('CutPage MDF-bath lifecycle error wiring', () => {
  it('sends the make-current fence (If-Match version + fresh Idempotency-Key) and handles its bath errors', () => {
    expect(source).toContain(
      'const updated = await cutApi.setCurrentResult(job.cutJobId, result.resultNo, job.version, commandId);',
    );
    expect(source).toContain('makeCurrentCommandRef.current = null;');
  });

  it('routes delete/archive, manual-layout save, and make-current errors through buildMdfBathErrorView', () => {
    const occurrences = source.match(/buildMdfBathErrorView\(error\)/g) ?? [];
    // make-current, delete/archive, manual layout; calculate classifies via isDefinitiveCalculationRejection.
    expect(occurrences.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain("import { buildMdfBathErrorView, createSingleFlight, isDefinitiveCalculationRejection } from './cutMdfBathErrors';");
  });

  it('reloads the job (openJob) when the MDF-bath error view says to', () => {
    expect(source.match(/if \(bathError\.reload\) await openJob\(targetJobId\);/g) ?? []).toHaveLength(2);
    expect(source).toContain('if (bathError.reload) await openJob(target.cutJobId);');
  });

  it('clears the calculate retry commandId after any definitive MDF-bath rejection', () => {
    // Classified BEFORE the follow-up refresh, so a failed refresh cannot keep the settled commandId.
    const catchIndex = source.indexOf('if (isDefinitiveCalculationRejection(error)) {');
    expect(catchIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeLessThan(source.indexOf('const fresh = await cutApi.get(job.cutJobId);'));
    expect(source).toContain('calcRefreshRequiredRef.current = targetJobId;');
    // The next click re-reads the job version before minting a replacement command.
    expect(source).toContain('if (calcRefreshRequiredRef.current === job.cutJobId) {');
  });
});
