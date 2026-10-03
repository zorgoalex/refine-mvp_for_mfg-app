import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('the «Сотрудник» field of a user', () => {
  it('is shown only with the backend users command (never a Hasura write of employee_id)', () => {
    for (const file of ['./create.tsx', './edit.tsx']) {
      const source = read(file);
      const field = source.indexOf('name="employee_id"');
      expect(field, file).toBeGreaterThan(0);
      const gate = source.lastIndexOf('featureFlags.useBackendUsers && (', field);
      expect(gate, file).toBeGreaterThan(0);
      expect(source.slice(gate, field).split(')}').length, file).toBe(1);
    }
  });
});

describe('order send settings add buttons', () => {
  it('cannot add a chat or an employee while the settings save', () => {
    const source = read('../configuration/components/broadcasts/OrderSendSettings.tsx');
    expect(source.match(/disabled=\{fieldsLocked \|\| fields\.length >= ORDER_SEND_MAX_(CHATS|EMPLOYEES)\}/g)).toHaveLength(2);
    expect(source.match(/onClick=\{\(\) => \{ if \(!fieldsLocked\) add\(/g)).toHaveLength(2);
  });
});
