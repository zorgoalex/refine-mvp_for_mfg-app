import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const component = readFileSync(new URL('./BulkEditModal.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./BulkEditModal.css', import.meta.url), 'utf8');

describe('compact bulk edit modal', () => {
  it('uses the compact hint and one-line note field', () => {
    expect(component).toContain('className="order-bulk-edit-modal__hint"');
    expect(component).not.toContain('description="Отметьте чекбоксами поля');
    expect(component).toContain('<Form className="order-bulk-edit-modal__form" form={form} layout="vertical" size="small">');
    expect(component).toContain('rows={1}');
  });

  it('keeps form rows and controls close to half their previous height', () => {
    expect(styles).toMatch(/\.order-bulk-edit-modal__hint\.ant-alert[\s\S]*?min-height:\s*28px/);
    expect(styles).toMatch(/\.order-bulk-edit-modal__form \.ant-form-item[\s\S]*?margin-bottom:\s*5px/);
    expect(styles).toMatch(/\.order-bulk-edit-modal__form \.ant-input-number,[\s\S]*?height:\s*22px/);
    expect(styles).toMatch(/textarea\.ant-input[\s\S]*?height:\s*22px/);
  });
});
