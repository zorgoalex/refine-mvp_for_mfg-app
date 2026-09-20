import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  form: vi.fn(),
  go: vi.fn(),
  title: vi.fn(),
  result: { queryResult: { data: { data: { vendor_id: 17 } } }, id: 17 },
}));
vi.mock('@refinedev/antd', () => ({ useForm: mocks.form }));
vi.mock('@refinedev/core', () => ({ useGo: () => mocks.go }));
vi.mock('../utils/recordTitle', () => ({ useRecordTabTitle: mocks.title }));
vi.mock('../utils/tabLabels', () => ({ RESOURCE_LABELS: { vendors: 'Поставщики' } }));

import { useFormWithHighlight } from './useFormWithHighlight';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.form.mockReturnValue(mocks.result);
});

describe('useFormWithHighlight form contract', () => {
  it.each(['create', 'edit'] as const)('preserves %s callbacks, resource and route', (action) => {
    const originalSuccess = vi.fn();
    const result = useFormWithHighlight({
      resource: 'vendors', idField: 'vendor_id', action, successResource: 'suppliers',
      formProps: { onMutationSuccess: originalSuccess, redirect: 'list' },
    });
    expect(result).toBe(mocks.result);
    const options = mocks.form.mock.calls[0][0];
    expect(options).toMatchObject({ resource: 'vendors', redirect: false });
    const response = { data: { vendor_id: 17 } };
    const variables = { name: 'E2E vendor' };
    const context = { previous: 'E2E value' };
    options.onMutationSuccess(response, variables, context, false);
    expect(originalSuccess).toHaveBeenCalledExactlyOnceWith(response, variables, context, false);
    expect(mocks.go).toHaveBeenCalledExactlyOnceWith(action === 'edit'
      ? { to: { resource: 'suppliers', action: 'show', id: 17 }, type: 'replace' }
      : { to: { resource: 'suppliers', action: 'list' }, query: { highlightId: 17 }, type: 'replace' });
    expect(originalSuccess.mock.invocationCallOrder[0]).toBeLessThan(mocks.go.mock.invocationCallOrder[0]);
    expect(mocks.title).toHaveBeenCalledExactlyOnceWith({
      resourceLabel: 'Поставщики', actionLabel: 'Редактирование',
      record: mocks.result.queryResult.data.data, fallbackId: 17, enabled: action === 'edit',
    });
  });

  it('keeps callbacks but disables navigation on request', () => {
    const success = vi.fn();
    useFormWithHighlight({ resource: 'payments', idField: 'payment_id',
      navigateOnSuccess: false, formProps: { onMutationSuccess: success } });
    mocks.form.mock.calls[0][0].onMutationSuccess({ data: { payment_id: 8 } }, {}, undefined, true);
    expect(success).toHaveBeenCalledOnce();
    expect(mocks.go).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, ''])('preserves no-navigation behavior for id %s', (id) => {
    useFormWithHighlight({ resource: 'vendors', idField: 'vendor_id' });
    mocks.form.mock.calls[0][0].onMutationSuccess({ data: { vendor_id: id } }, {}, undefined, false);
    expect(mocks.go).not.toHaveBeenCalled();
  });

  it('uses the data resource by default and preserves string IDs', () => {
    useFormWithHighlight({ resource: 'vendors', idField: 'vendor_id' });
    mocks.form.mock.calls[0][0].onMutationSuccess({ data: { vendor_id: '17' } }, {}, undefined, false);
    expect(mocks.go).toHaveBeenCalledExactlyOnceWith({
      to: { resource: 'vendors', action: 'list' }, query: { highlightId: '17' }, type: 'replace',
    });
  });
});
