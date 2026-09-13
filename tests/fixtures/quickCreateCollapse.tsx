import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Refine } from '@refinedev/core';
import { EdgeTypeQuickCreate } from '../../src/pages/orders/components/modals/EdgeTypeQuickCreate';
import { MillingTypeQuickCreate } from '../../src/pages/orders/components/modals/MillingTypeQuickCreate';
import { writeWorkspaceUiCheckpoint } from '../../src/workspace/workspaceUiStateStore';

const params = new URLSearchParams(location.search);
const milling = params.get('kind') === 'milling';
const nameField = milling ? 'milling_type_name' : 'edge_type_name';
if (params.has('restore')) {
  writeWorkspaceUiCheckpoint('/orders/create', {
    schemaVersion: 1,
    adapters: {
      [milling ? 'milling-quick-create' : 'edge-quick-create']: {
        open: true, form: { values: { [nameField]: 'Восстановленный тип', sort_order: 37 }, fields: [] },
      },
    },
  });
}
const dataProvider = {
  getApiUrl: () => location.origin,
  getList: async () => ({ data: [], total: 0 }),
  getOne: async () => ({ data: {} }),
  update: async () => ({ data: {} }),
  deleteOne: async () => ({ data: {} }),
  create: async ({ resource, variables }) => {
    const response = await fetch('/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource, variables }),
    });
    if (!response.ok) throw new Error('Тестовая ошибка API');
    return { data: await response.json() };
  },
};
function Fixture() {
  const [open, setOpen] = useState(true);
  const [saved, setSaved] = useState<number[]>([]);
  const Modal = milling ? MillingTypeQuickCreate : EdgeTypeQuickCreate;
  return <Refine dataProvider={dataProvider} options={{ disableTelemetry: true }}>
    <button onClick={() => setOpen(true)}>Открыть тестовую форму</button>
    <output data-testid="saved">{JSON.stringify(saved)}</output>
    <Modal open={open} onClose={() => setOpen(false)} onSuccess={id => setSaved(previous => [...previous, id])} />
  </Refine>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
