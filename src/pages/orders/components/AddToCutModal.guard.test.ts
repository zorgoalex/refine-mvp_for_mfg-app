import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const modalSrc = readFileSync(new URL('./AddToCutModal.tsx', import.meta.url), 'utf8');
const listSrc = readFileSync(new URL('../list.tsx', import.meta.url), 'utf8');

describe('AddToCutModal wiring (backend-owned, flag-guarded)', () => {
  it('drives only the backend cut-jobs API (no page-level Hasura write)', () => {
    expect(modalSrc).toMatch(/cutApi\.create/);
    expect(modalSrc).toMatch(/cutApi\.listEligibleDetails/);
    expect(modalSrc).toMatch(/cutApi\.addItems/);
    // No direct read-layer/GraphQL write from the page (CLAUDE.md principle 3):
    // it must not import the dataProvider or issue a raw GraphQL mutation.
    expect(modalSrc).not.toMatch(/import[\s\S]*dataProvider/);
    expect(modalSrc).not.toMatch(/mutation\s|gql`/);
  });

  it('only adds eligible details (reuses selectableDetailIds)', () => {
    expect(modalSrc).toMatch(/selectableDetailIds/);
  });

  it('is mounted in the orders list only behind the useBackendCut flag', () => {
    expect(listSrc).toMatch(/featureFlags\.useBackendCut/);
    // Both the toolbar button and the modal are guarded by the flag.
    expect(listSrc).toMatch(/useBackendCut\s*&&[\s\S]*AddToCutModal/);
    expect(listSrc).toMatch(/rowSelection=\{[\s\S]*useBackendCut/);
  });
});

describe('AddToCutModal detail-level mode', () => {
  it('is backend-owned (cutApi only, no Hasura/graphql/fetch)', () => {
    expect(modalSrc).toContain("from '../../../api/cutApi'");
    expect(modalSrc).not.toMatch(/hasura/i);
    expect(modalSrc).not.toMatch(/graphql/i);
    expect(modalSrc).not.toMatch(/\bfetch\(/);
  });

  it('restricts chosen ids to eligible via restrictDetailIds', () => {
    expect(modalSrc).toContain('detailIds');
    expect(modalSrc).toContain('restrictDetailIds');
  });

  it('rolls back an empty new draft via archive (no orphan job)', () => {
    expect(modalSrc).toContain('cutApi.archive');
  });

  it('uses order display names, not raw order ids, in the default cut name when names are provided', () => {
    expect(modalSrc).toContain('orderNames?:');
    expect(modalSrc).toContain('formatOrderLabelForCutName');
    expect(modalSrc).not.toContain('Раскрой заказ ${orderIds.join');
  });
});
