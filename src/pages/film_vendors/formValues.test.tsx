import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormProps } from 'antd';
import type { FilmVendorFormValues } from './formValues';

const mocks = vi.hoisted(() => ({
  finish: vi.fn(),
  error: vi.fn(),
  form: vi.fn(),
}));
vi.mock('@refinedev/antd', () => ({
  Create: ({ children }: React.PropsWithChildren) => children,
  Edit: ({ children }: React.PropsWithChildren) => children,
}));
vi.mock('../../hooks/useFormWithHighlight', () => ({
  useFormWithHighlight: () => ({ formProps: { onFinish: mocks.finish }, saveButtonProps: {} }),
}));
vi.mock('antd', () => ({
  Form: Object.assign((props: FormProps<FilmVendorFormValues>) => {
    mocks.form(props);
    return null;
  }, { Item: () => null }),
  Input: Object.assign(() => null, { TextArea: () => null }),
  Checkbox: () => null,
  message: { error: mocks.error },
}));
import { FilmVendorCreate } from './create';
import { FilmVendorEdit } from './edit';

beforeEach(() => {
  vi.clearAllMocks();
  // The Node test config uses classic JSX; production Vite uses automatic JSX.
  vi.stubGlobal('React', React);
});
afterEach(() => vi.unstubAllGlobals());

describe.each([['create', FilmVendorCreate], ['edit', FilmVendorEdit]] as const)(
  'film vendor %s values',
  (_, Component) => {
    it('trims the name, preserves other values and forwards the submit result', async () => {
      const result = { data: { film_vendor_id: 7 } };
      mocks.finish.mockResolvedValueOnce(result);
      renderToString(<Component />);
      const input = { film_vendor_name: '  E2E поставщик  ', ref_key_1c: 'E2E-ref',
        contact_info: 'E2E contact', is_active: false };
      await expect(mocks.form.mock.calls[0][0].onFinish(input)).resolves.toBe(result);
      expect(mocks.finish).toHaveBeenCalledExactlyOnceWith({ ...input, film_vendor_name: 'E2E поставщик' });
      expect(input.film_vendor_name).toBe('  E2E поставщик  ');
      expect(mocks.error).not.toHaveBeenCalled();
    });

    it.each(['', '   ', undefined])('rejects blank name %s without submitting', async (name) => {
      renderToString(<Component />);
      await mocks.form.mock.calls[0][0].onFinish({ film_vendor_name: name });
      expect(mocks.finish).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledExactlyOnceWith('Введите название поставщика плёнки');
    });
  },
);
