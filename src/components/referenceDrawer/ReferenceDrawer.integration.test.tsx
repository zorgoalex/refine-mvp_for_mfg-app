import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Refine, useList, type DataProvider } from '@refinedev/core';
import { MemoryRouter } from 'react-router-dom';

// Без DOM (тесты репозитория идут в node): антд-панель — без портала, интерфейс форм не рисуется. Всё остальное
// настоящее: refine, useForm из @refinedev/antd, контекст панели, useReferenceForm / useFormWithHighlight.
vi.mock('antd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('antd')>()),
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div data-drawer>{children}</div> : null),
  Spin: () => null,
}));
vi.mock('../../utils/resourcePermissions', () => ({ canMutateHasuraResource: () => true }));

const exposed = vi.hoisted(() => ({ onFinish: null as null | ((values: Record<string, unknown>) => Promise<unknown> | unknown) }));

vi.mock('./referenceDrawerForms', async () => {
  const { useReferenceForm } = await import('./useReferenceForm');
  const { useFormWithHighlight } = await import('../../hooks/useFormWithHighlight');
  // формы как на страницах справочников: одна на useReferenceForm («Единицы»), другая на useFormWithHighlight («Кромки»)
  const UnitsForm = () => {
    const { formProps } = useReferenceForm();
    exposed.onFinish = formProps.onFinish as typeof exposed.onFinish;
    return null;
  };
  const EdgeForm = () => {
    const { formProps } = useFormWithHighlight({ resource: 'edge_types', idField: 'edge_type_id', action: 'edit' });
    exposed.onFinish = formProps.onFinish as typeof exposed.onFinish;
    return null;
  };
  return {
    REFERENCE_DRAWER_FORMS: {
      units: { edit: UnitsForm, create: UnitsForm },
      edge_types: { edit: EdgeForm, create: EdgeForm },
    },
  };
});
vi.mock('@refinedev/antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@refinedev/antd')>();
  return { ...actual, EditButton: (props: Record<string, unknown>) => <span data-edit-button data-has-click={Boolean(props.onClick)} /> };
});

import { ReferenceDrawerHost } from './ReferenceDrawerHost';
import { useReferenceDrawerOpener, type ReferenceDrawerOpener } from './ReferenceDrawerContext';
import { ReferenceEditButton } from './ReferenceEditButton';

const records: Record<string, Record<string, unknown>> = {
  5: { unit_id: 5, unit_code: 'm2', unit_name: 'квадратный метр' },
  9: { unit_id: 9, unit_code: 'pcs', unit_name: 'штука' },
  3: { edge_type_id: 3, edge_type_name: 'Кромка 0,4' },
};
const calls = {
  getList: [] as string[],
  getOne: [] as string[],
  update: [] as Array<{ resource: string; id: unknown; variables: unknown }>,
  create: [] as Array<{ resource: string; variables: unknown }>,
};
let failUpdate = false;

const dataProvider: DataProvider = {
  getApiUrl: () => '',
  getList: async ({ resource }) => { calls.getList.push(resource); return { data: [] as never[], total: 0 }; },
  getOne: async ({ resource, id }) => { calls.getOne.push(`${resource}:${id}`); return { data: records[String(id)] as never }; },
  update: async ({ resource, id, variables }) => {
    calls.update.push({ resource, id, variables });
    if (failUpdate) throw Object.assign(new Error('forbidden'), { statusCode: 403, message: 'forbidden' });
    return { data: { ...records[String(id)], ...(variables as object) } as never };
  },
  create: async ({ resource, variables }) => { calls.create.push({ resource, variables }); return { data: { id: 77, ...(variables as object) } as never }; },
  deleteOne: async () => ({ data: {} as never }),
};

let opener: ReferenceDrawerOpener | null = null;
const Probe: React.FC<{ resource: string }> = ({ resource }) => {
  opener = useReferenceDrawerOpener();
  useList({ resource }); // список под панелью
  return null;
};

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
};

describe('NewLine reference side panel — real refine data flow', () => {
  let renderer: ReactTestRenderer | undefined;
  const mount = async (resource: string) => {
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={[`/${resource === 'units' ? 'units' : 'edge-types'}`]}>
        <Refine
          dataProvider={dataProvider}
          resources={[
            { name: 'units', list: '/units', edit: '/units/edit/:id', create: '/units/create' },
            { name: 'edge_types', list: '/edge-types', edit: '/edge-types/edit/:id', create: '/edge-types/create' },
          ]}
          options={{ disableTelemetry: true, reactQuery: { clientConfig: { defaultOptions: { queries: { retry: false } } } } }}
        >
          <ReferenceDrawerHost resource={resource} title="Справочник" enabled>
            <Probe resource={resource} />
          </ReferenceDrawerHost>
        </Refine>
        </MemoryRouter>,
      );
    });
    await flush();
  };
  const drawerOpen = () => (renderer?.root.findAll((node) => node.props['data-drawer'] === true).length ?? 0) > 0;
  const submit = async (values: Record<string, unknown>) => {
    await act(async () => { await Promise.resolve(exposed.onFinish?.(values)).catch(() => undefined); });
    await flush();
  };

  beforeEach(() => {
    calls.getList = [];
    calls.getOne = [];
    calls.update = [];
    calls.create = [];
    failUpdate = false;
    opener = null;
    exposed.onFinish = null;
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('edit 5 → saved, closed, list re-read; edit 9 → failed save keeps the panel; create → no id', async () => {
    await mount('units');
    const listReadsBefore = calls.getList.length;

    await act(async () => { opener!.open('edit', 5); });
    await flush();
    expect(calls.getOne).toEqual(['units:5']);
    await submit({ unit_code: 'm2', unit_name: 'Квадратный метр' });
    // после сохранения refine перечитывает запись 5 (инвалидация) — 9 ещё не читалась
    expect(calls.getOne.every((call) => call === 'units:5')).toBe(true);
    expect(calls.update).toEqual([{ resource: 'units', id: 5, variables: { unit_code: 'm2', unit_name: 'Квадратный метр' } }]);
    expect(drawerOpen()).toBe(false);
    expect(calls.getList.length).toBeGreaterThan(listReadsBefore);

    failUpdate = true;
    await act(async () => { opener!.open('edit', 9); });
    await flush();
    expect(calls.getOne.at(-1)).toBe('units:9');
    await submit({ unit_code: 'pcs', unit_name: 'Штука' });
    expect(calls.update.at(-1)).toEqual({ resource: 'units', id: 9, variables: { unit_code: 'pcs', unit_name: 'Штука' } });
    expect(drawerOpen()).toBe(true);

    await act(async () => { opener!.open('create'); });
    await flush();
    await submit({ unit_code: 'kg', unit_name: 'Килограмм' });
    expect(calls.create).toEqual([{ resource: 'units', variables: { unit_code: 'kg', unit_name: 'Килограмм' } }]);
    expect(calls.update).toHaveLength(2);
    expect(drawerOpen()).toBe(false);
  });

  it('a form on useFormWithHighlight saves the opened record and closes without navigating', async () => {
    await mount('edge_types');
    await act(async () => { opener!.open('edit', 3); });
    await flush();
    expect(calls.getOne[0]).toBe('edge_types:3');
    await submit({ edge_type_name: 'Кромка 0,8' });
    expect(calls.update).toEqual([{ resource: 'edge_types', id: 3, variables: { edge_type_name: 'Кромка 0,8' } }]);
    expect(drawerOpen()).toBe(false);
  });

  it('without a panel the row button is the plain refine EditButton (navigation as before)', async () => {
    let tree: ReactTestRenderer | undefined;
    await act(async () => { tree = create(<ReferenceEditButton hideText size="small" recordItemId={5} />); });
    const button = tree!.root.findAll((node) => node.props['data-edit-button'] === true)[0];
    expect(button.props['data-has-click']).toBe(false);
    act(() => tree?.unmount());
  });
});
