import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { FormInstance } from 'antd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KeepAliveContext } from '../components/workspace/KeepAliveContext';
import { clearWorkspaceCheckpointRegistry } from './workspaceCheckpointRegistry';
import { useWorkspaceModalFormCheckpoint } from './workspaceModalFormCheckpoint';
import { clearWorkspaceUiState, writeWorkspaceUiCheckpoint } from './workspaceUiStateStore';

const WORKSPACE_KEY = '/orders/edit/42';

function QuickForm({ open, form }: { open: boolean; form: FormInstance }) {
  useWorkspaceModalFormCheckpoint('quick-form', open, form);
  return null;
}

function renderQuickForm(open: boolean, form: FormInstance) {
  return TestRenderer.create(
    <KeepAliveContext.Provider value={{
      isActive: true,
      tabKey: WORKSPACE_KEY,
      workspaceActive: true,
      activationRevision: 1,
      documentVisible: true,
      surfaceActive: true,
    }}>
      <QuickForm open={open} form={form} />
    </KeepAliveContext.Provider>,
  );
}

describe('workspace modal form checkpoint hook', () => {
  beforeEach(() => {
    clearWorkspaceCheckpointRegistry();
    clearWorkspaceUiState();
  });

  it('restores an open quick form without validation or submit', async () => {
    writeWorkspaceUiCheckpoint(WORKSPACE_KEY, {
      schemaVersion: 1,
      adapters: {
        'quick-form': {
          open: true,
          form: {
            values: { name: 'raw draft' },
            fields: [{
              name: ['name'], touched: true, errors: ['invalid'], warnings: [],
            }],
          },
        },
      },
    });
    const setFieldsValue = vi.fn();
    const setFields = vi.fn();
    const validateFields = vi.fn();
    const submit = vi.fn();
    const form = {
      setFieldsValue,
      setFields,
      validateFields,
      submit,
      getFieldsValue: vi.fn(() => ({})),
      getFieldsError: vi.fn(() => []),
      isFieldTouched: vi.fn(() => false),
    } as unknown as FormInstance;

    let view!: ReturnType<typeof renderQuickForm>;
    await act(async () => {
      view = renderQuickForm(true, form);
    });

    expect(setFieldsValue).toHaveBeenCalledWith({ name: 'raw draft' });
    expect(setFields).toHaveBeenCalled();
    expect(validateFields).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });

  it('does not resurrect a checkpoint whose modal was closed', async () => {
    writeWorkspaceUiCheckpoint(WORKSPACE_KEY, {
      schemaVersion: 1,
      adapters: {
        'quick-form': {
          open: false,
          form: { values: { name: 'cancelled' }, fields: [] },
        },
      },
    });
    const setFieldsValue = vi.fn();
    const form = {
      setFieldsValue,
      setFields: vi.fn(),
      getFieldsValue: vi.fn(() => ({})),
      getFieldsError: vi.fn(() => []),
      isFieldTouched: vi.fn(() => false),
    } as unknown as FormInstance;

    let view!: ReturnType<typeof renderQuickForm>;
    await act(async () => {
      view = renderQuickForm(true, form);
    });

    expect(setFieldsValue).not.toHaveBeenCalled();
    await act(async () => view.unmount());
  });
});
