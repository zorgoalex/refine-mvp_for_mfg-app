import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./CutSheetLabelGenerateAction.tsx', import.meta.url)), 'utf8');

describe('CutSheetLabelGenerateAction source guard', () => {
  it('persists the trailing blank label print toggle per user', () => {
    expect(source).toContain('loadAppendBlankLabelOnPrintPreference(labelTemplatePreferenceUserId)');
    expect(source).toContain('saveAppendBlankLabelOnPrintPreference(labelTemplatePreferenceUserId, checked)');
    expect(source).toContain('Добавлять в конец пустую бирку');
    expect(source).toContain('appendBlankPage: appendBlankLabelOnPrint');
  });
});
