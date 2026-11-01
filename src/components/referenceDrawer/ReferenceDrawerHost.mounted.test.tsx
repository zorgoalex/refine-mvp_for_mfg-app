import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  canWrite: true,
  formCalls: [] as Array<Record<string, unknown>>,
  lastOptions: null as null | { onMutationSuccess?: (...args: unknown[]) => void },
}));

vi.mock('antd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('antd')>()),
  // панель без портала: в тестовом рендерере видно её содержимое
  Drawer: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div data-drawer>{children}</div> : null),
  Spin: () => null,
}));
vi.mock('@refinedev/antd', () => ({
  useForm: (options: Record<string, unknown>) => {
    env.formCalls.push(options);
    env.lastOptions = options as typeof env.lastOptions;
    return { formProps: {}, saveButtonProps: {} };
  },
}));
vi.mock('../../utils/resourcePermissions', () => ({ canMutateHasuraResource: () => env.canWrite }));
vi.mock('./referenceDrawerForms', async () => {
  const { useReferenceForm } = await import('./useReferenceForm');
  const Form = () => {
    useReferenceForm();
    return null;
  };
  return { REFERENCE_DRAWER_FORMS: { units: { edit: Form, create: Form } } };
});

import { ReferenceDrawerHost } from './ReferenceDrawerHost';
import { useReferenceDrawerOpener, type ReferenceDrawerOpener } from './ReferenceDrawerContext';

let opener: ReferenceDrawerOpener | null = null;
const Probe = () => {
  opener = useReferenceDrawerOpener();
  return null;
};

describe('ReferenceDrawerHost mounted', () => {
  let renderer: ReactTestRenderer | undefined;
  const render = async (props: { enabled?: boolean; resource?: string } = {}) => {
    await act(async () => {
      const element = (
        <ReferenceDrawerHost resource={props.resource ?? 'units'} title="Единицы" enabled={props.enabled ?? true}>
          <Probe />
        </ReferenceDrawerHost>
      );
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  };
  const drawerOpen = () => (renderer?.root.findAll((node) => node.props['data-drawer'] === true).length ?? 0) > 0;

  beforeEach(() => {
    env.canWrite = true;
    env.formCalls = [];
    env.lastOptions = null;
    opener = null;
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('edits exactly the opened record, then another one, then creates — each a fresh form', async () => {
    await render();
    await act(async () => { opener!.open('edit', 5); });
    expect(env.formCalls.at(-1)).toMatchObject({ resource: 'units', action: 'edit', id: 5, redirect: false });
    await act(async () => { opener!.open('edit', 9); });
    expect(env.formCalls.at(-1)).toMatchObject({ resource: 'units', action: 'edit', id: 9 });
    await act(async () => { opener!.open('create'); });
    const created = env.formCalls.at(-1)!;
    expect(created).toMatchObject({ resource: 'units', action: 'create' });
    expect(created.id).toBeUndefined();
  });

  it('closes the panel after a successful save', async () => {
    await render();
    await act(async () => { opener!.open('edit', 5); });
    expect(drawerOpen()).toBe(true);
    await act(async () => { env.lastOptions!.onMutationSuccess!({ data: {} }, {}, undefined, false); });
    expect(drawerOpen()).toBe(false);
  });

  it('without the write right the panel never opens (buttons keep navigating)', async () => {
    env.canWrite = false;
    await render();
    expect(opener!.canOpen('edit')).toBe(false);
    expect(opener!.canOpen('create')).toBe(false);
    await act(async () => { opener!.open('edit', 5); });
    expect(drawerOpen()).toBe(false);
    expect(env.formCalls).toHaveLength(0);
  });

  it('outside NewLine reference lists, or for a book without a panel form, there is no panel at all', async () => {
    await render({ enabled: false });
    expect(opener).toBeNull();
    await render({ enabled: true, resource: 'employees' });
    expect(opener).toBeNull();
  });
});
