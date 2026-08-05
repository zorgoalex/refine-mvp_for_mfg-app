import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const edit = readFileSync(new URL('./edit.tsx', import.meta.url), 'utf8');
const mobile = readFileSync(new URL('./mobile/DetailCardList.tsx', import.meta.url), 'utf8');

describe('ERP order view Basis-cut references', () => {
  it('adds the clickable Basis-cut column to the view form only', () => {
    expect(show).toContain("{ key: 'bazis_cut_sets', label: 'Базис-раскрой' }");
    expect(show).toContain("title: 'Базис-раскрой'");
    expect(show).toContain('to={`/bazis-cut/${cutSet.bazisCutSetId}`}');
    expect(show).toContain('`БР-${cutSet.bazisCutSetId}`');
    expect(edit).not.toContain("title: 'Базис-раскрой'");
  });

  it('shows the same references in mobile detail cards', () => {
    expect(show).toContain('bazisCutLinkEnabled={bazisCutLinkEnabled}');
    expect(mobile).toContain('Базис-раскрой:');
    expect(mobile).toContain('to={`/bazis-cut/${cutSet.bazisCutSetId}`}');
  });
});
