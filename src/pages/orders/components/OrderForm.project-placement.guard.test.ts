import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const formSource = readFileSync(
  fileURLToPath(new URL('./OrderForm.tsx', import.meta.url)),
  'utf8',
);
const basicInfoSource = readFileSync(
  fileURLToPath(new URL('./sections/OrderBasicInfo.tsx', import.meta.url)),
  'utf8',
);

describe('OrderForm project placement', () => {
  it('keeps project information inside the basic-information tab without a standalone card', () => {
    expect(formSource).toContain('projectField={projectField}');
    expect(formSource).not.toContain('<Card size="small" title="Проект">');
    expect(formSource).not.toContain('<OrderHeaderSummary />\n      {projectField}');

    expect(basicInfoSource).toContain('projectField?: React.ReactNode;');
    expect(basicInfoSource).toContain('{projectField ? (');
    expect(basicInfoSource).toContain('{projectField}');
  });
});
