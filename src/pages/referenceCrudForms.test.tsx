import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaterialTransactionTypeCreate } from './material_transaction_types/create';
import { MaterialTransactionTypeEdit } from './material_transaction_types/edit';
import { MovementStatusCreate } from './movements_statuses/create';
import { MovementStatusEdit } from './movements_statuses/edit';
import { ProductionStatusCreate } from './production_statuses/create';
import { ProductionStatusEdit } from './production_statuses/edit';
import { RequisitionStatusCreate } from './requisition_statuses/create';
import { RequisitionStatusEdit } from './requisition_statuses/edit';
import { TransactionDirectionCreate } from './transaction_direction/create';
import { TransactionDirectionEdit } from './transaction_direction/edit';
import { UnitCreate } from './units/create';
import { UnitEdit } from './units/edit';

type Values = Record<string, unknown>;
type CapturedForm = {
  onFinish: (values: Values) => unknown;
  initialValues?: Values;
  children?: React.ReactNode;
};

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  error: vi.fn(),
  useSelect: vi.fn(() => ({ selectProps: {} })),
  form: undefined as CapturedForm | undefined,
  saveEnabled: true,
  formProps: { disabled: true, initialValues: { direction_type_id: 7 } },
}));

// Capture the actual pages' Form handlers; no network writes or reimplemented handlers.
vi.mock('@refinedev/antd', () => ({
  Create: ({ children }: React.PropsWithChildren) => children,
  Edit: ({ children }: React.PropsWithChildren) => children,
  useForm: () => ({
    formProps: { ...mocks.formProps, onFinish: mocks.saveEnabled ? mocks.save : undefined },
    saveButtonProps: {},
    queryResult: { data: { data: { direction_type_id: 7 } } },
  }),
  useSelect: mocks.useSelect,
}));
vi.mock('antd', () => ({
  Form: Object.assign((props: CapturedForm) => { mocks.form = props; return null; }, { Item: () => null }),
  Input: Object.assign(() => null, { TextArea: () => null }),
  InputNumber: () => null,
  Checkbox: () => null,
  Select: () => null,
  message: { error: mocks.error },
}));
vi.mock('../components/ReferenceSortOrder', () => ({ ReferenceSortOrderFormItem: () => null }));
vi.mock('../components/StatusColor', () => ({ StatusColorFormItem: () => null }));

const cases = [
  {
    resource: 'material_transaction_types', components: [MaterialTransactionTypeCreate, MaterialTransactionTypeEdit],
    input: { transaction_type_name: '  Тест приёмка  ', direction_type_id: 7, affects_stock: false, requires_document: false, is_active: false, sort_order: 0, description: null },
    trimmed: { transaction_type_name: 'Тест приёмка' },
    required: { transaction_type_name: 'Name is required', direction_type_id: 'Direction is required' },
    defaults: { is_active: true, sort_order: 100, affects_stock: true, requires_document: false },
  },
  {
    resource: 'movements_statuses', components: [MovementStatusCreate, MovementStatusEdit],
    input: { movement_status_code: '  test_ready  ', movement_status_name: '  Тест готов  ', is_active: false, sort_order: 0, description: null },
    trimmed: { movement_status_code: 'test_ready', movement_status_name: 'Тест готов' },
    required: { movement_status_code: 'Code and Name are required', movement_status_name: 'Code and Name are required' },
    defaults: { is_active: true, sort_order: 100 },
  },
  {
    resource: 'production_statuses', components: [ProductionStatusCreate, ProductionStatusEdit],
    input: { production_status_name: '  Тест готов  ', production_status_code: 'existing_code', color: null, ref_key_1c: null, description: null, is_active: false, sort_order: 1 },
    trimmed: { production_status_name: 'Тест готов' },
    // These pages use AntD rules, not a second validation branch in onFinish.
    required: {},
    defaults: { is_active: true, sort_order: 100 },
  },
  {
    resource: 'requisition_statuses', components: [RequisitionStatusCreate, RequisitionStatusEdit],
    input: { requisition_status_name: '  Тест заявка  ', is_active: false, sort_order: 0, description: null },
    trimmed: { requisition_status_name: 'Тест заявка' },
    required: { requisition_status_name: 'Name is required' },
    defaults: { is_active: true, sort_order: 100 },
  },
  {
    resource: 'transaction_direction', components: [TransactionDirectionCreate, TransactionDirectionEdit],
    input: { direction_code: '  TEST_IN  ', direction_name: '  Тест приход  ', is_active: false, sort_order: 0, description: null },
    trimmed: { direction_code: 'TEST_IN', direction_name: 'Тест приход' },
    required: { direction_code: 'Code is required', direction_name: 'Name is required' },
    defaults: { is_active: true },
  },
  {
    resource: 'units', components: [UnitCreate, UnitEdit],
    input: { unit_code: '  test_pcs  ', unit_name: '  Тест штука  ', unit_symbol: null, decimals: 0, ref_key_1c: null, sort_order: 0 },
    trimmed: { unit_code: 'test_pcs', unit_name: 'Тест штука' },
    required: { unit_code: 'Code and Name are required', unit_name: 'Code and Name are required' },
    defaults: undefined,
  },
];

beforeEach(() => {
  // Vitest's Node config uses classic JSX; production Vite injects React automatically.
  vi.stubGlobal('React', React);
  vi.clearAllMocks();
  mocks.save.mockReset().mockResolvedValue({ data: { id: 42 } });
  mocks.form = undefined;
  mocks.saveEnabled = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const scenario of cases) {
  for (const [index, Component] of scenario.components.entries()) {
    const mode = index === 0 ? 'create' : 'edit';
    const mount = () => {
      renderToStaticMarkup(<Component />);
      expect(mocks.form).toBeDefined();
      return mocks.form!;
    };
    describe(`${scenario.resource} ${mode} submit contract`, () => {
      it('trims names/codes, preserves optional values, and delegates exactly once', async () => {
        const input = Object.freeze({ ...scenario.input });
        const expected: Values = { ...input, ...scenario.trimmed };
        if (scenario.resource === 'production_statuses') {
          if (mode === 'edit') delete expected.production_status_code;
          else expected.production_status_code = expect.stringMatching(/^test_gotov_[a-z0-9]{32}$/);
        }
        expect(await mount().onFinish(input)).toEqual({ data: { id: 42 } });
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith(expected);
        expect(mocks.error).not.toHaveBeenCalled();
        expect(input).toEqual(scenario.input);
      });

      it('preserves rejection from the save operation', async () => {
        const failure = new Error('Тест save failed');
        mocks.save.mockRejectedValueOnce(failure);
        await expect(mount().onFinish({ ...scenario.input })).rejects.toBe(failure);
        expect(mocks.save).toHaveBeenCalledTimes(1);
      });

      it('tolerates an absent Refine save callback', async () => {
        mocks.saveEnabled = false;
        expect(await mount().onFinish({ ...scenario.input })).toBeUndefined();
        expect(mocks.save).not.toHaveBeenCalled();
      });

      it('retains Refine form props and existing create defaults', () => {
        const form = mount();
        expect(form).toMatchObject({ disabled: true });
        expect(form.initialValues).toEqual(mode === 'create' && scenario.defaults
          ? scenario.defaults : mocks.formProps.initialValues);
      });

      if (scenario.resource === 'production_statuses') {
        it('keeps AntD required-name validation and hides the technical code', () => {
          const fields = React.Children.toArray(mount().children)
            .filter(React.isValidElement<{ name?: string; rules?: unknown[] }>);
          const name = fields.find((field) => field.props.name === 'production_status_name');
          expect(name?.props.rules).toEqual([{ required: true, whitespace: true }]);
          expect(fields.some((field) => field.props.name === 'production_status_code')).toBe(false);
        });
      }

      for (const [field, message] of Object.entries(scenario.required)) {
        const emptyValues = field === 'direction_type_id' ? [undefined, null, 0] : [undefined, null, '', '  '];
        it.each(emptyValues)(`rejects empty ${field}: %s`, async (empty) => {
          await mount().onFinish({ ...scenario.input, [field]: empty });
          expect(mocks.save).not.toHaveBeenCalled();
          expect(mocks.error).toHaveBeenCalledExactlyOnceWith(message);
        });
      }

      if (scenario.resource === 'material_transaction_types') {
        it('retains numeric direction selection and edit default', () => {
          mount();
          expect(mocks.useSelect).toHaveBeenCalledExactlyOnceWith({
            resource: 'transaction_direction', optionLabel: 'direction_name', optionValue: 'direction_type_id',
            ...(mode === 'edit' ? { defaultValue: 7 } : {}),
          });
        });
      }
    });
  }
}
