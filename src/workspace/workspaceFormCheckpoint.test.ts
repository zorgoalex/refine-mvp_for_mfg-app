import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import type { FormInstance } from 'antd';
import {
  captureAntFormCheckpoint,
  restoreAntFormCheckpoint,
} from './workspaceFormCheckpoint';

describe('Ant form workspace checkpoint', () => {
  it('restores values, touched/errors and dates without validation or submit', () => {
    const source = {
      getFieldsValue: vi.fn(() => ({
        amount: '12,',
        paymentDate: dayjs('2026-08-15'),
      })),
      getFieldsError: vi.fn(() => [{
        name: ['amount'],
        errors: ['Некорректное число'],
        warnings: ['Проверьте сумму'],
      }]),
      isFieldTouched: vi.fn(() => true),
    } as unknown as FormInstance;
    const checkpoint = captureAntFormCheckpoint(source);
    const setFieldsValue = vi.fn();
    const setFields = vi.fn();
    const validateFields = vi.fn();
    const submit = vi.fn();
    const target = { setFieldsValue, setFields, validateFields, submit } as unknown as FormInstance;

    expect(restoreAntFormCheckpoint(target, checkpoint)).toBe(true);
    expect(setFieldsValue).toHaveBeenCalledWith(expect.objectContaining({ amount: '12,' }));
    expect(dayjs.isDayjs(setFieldsValue.mock.calls[0][0].paymentDate)).toBe(true);
    expect(setFields).toHaveBeenCalledWith([{
      name: ['amount'],
      touched: true,
      errors: ['Некорректное число'],
      warnings: ['Проверьте сумму'],
    }]);
    expect(validateFields).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects malformed restore payload without mutating form', () => {
    const setFieldsValue = vi.fn();
    const setFields = vi.fn();
    const form = { setFieldsValue, setFields } as unknown as FormInstance;
    expect(restoreAntFormCheckpoint(form, { values: {}, fields: 'bad' })).toBe(false);
    expect(setFieldsValue).not.toHaveBeenCalled();
    expect(setFields).not.toHaveBeenCalled();
  });
});
