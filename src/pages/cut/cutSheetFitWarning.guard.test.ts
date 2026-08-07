import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.resolve(__dirname, 'CutPage.tsx'), 'utf8');

describe('CutPage selected sheet fit warning', () => {
  it('renders backend-authoritative warnings directly below the selected sheet', () => {
    expect(source).toContain('job.sheetFitWarnings');
    expect(source).toContain('data-testid="cut-sheet-fit-warning"');
    expect(source).toContain("fontSize: 12");
    expect(source).toContain('token.colorError');
    expect(source).toContain("warning.reason === 'orientation'");
  });
});
