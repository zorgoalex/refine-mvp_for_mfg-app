import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGroups, type CadGroup, type CadVariant, type CadSourceSnapshot } from '@shared/cad-workspace';
const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('../../api/cadApi', () => ({ cadApi: { preview } }));
import { useCadPreview } from './useCadPreview';
import { expandInstances } from './cadInstances';

let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useCadPreview>, base: CadVariant, draft: CadVariant;
let active: boolean, visible: string[];
const result = (groups: CadGroup[]) => ({ items: groups.map(g => ({ part_id: g.id, status: 'succeeded', result: { input_recipe: g.recipe } })) });
function Probe() { current = useCadPreview(base, draft, null, active, visible); return null; }
async function render() { await act(async () => { if (renderer) renderer.update(<Probe />); else renderer = create(<Probe />); }); }
async function advance() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
beforeEach(() => {
  vi.useFakeTimers(); active = true;
  const source: CadSourceSnapshot = { id: 'source', orderId: 1, orderName: 'Тест', capturedAt: '', parts: [{ orderId: 1, detailId: 1, detailNumber: 1,
    quantity: 300, widthMm: 100, heightMm: 200, thicknessMm: 16, material: 'МДФ', millingTypeId: 1, millingName: '', edgeName: '',
    recipe: { code: 'neo', version: '1', parameters: {} } }] };
  base = { id: 'variant', workspaceId: 'workspace', name: 'Тест', kind: 'working', version: 1, createdAt: '', parentId: null, jobId: null, renderRevision: null,
    sources: [source], groups: createGroups([source], () => 'persisted') };
  draft = { ...base, groups: expandInstances(base.groups, base.sources, (id, n) => `${id}-${n}`) };
  visible = draft.groups.map(g => g.id);
  preview.mockReset().mockImplementation(async (_base, groups) => result(groups));
});
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; vi.useRealTimers(); });

it('shares geometry for300 unsaved copies using only persisted same-source identity; movement does not refetch', async () => {
  await render(); await advance();
  expect(preview).toHaveBeenCalledTimes(1);
  expect(preview.mock.calls[0][1].map((g: CadGroup) => g.id)).toEqual(['persisted']);
  expect(current.scene.items).toHaveLength(300);
  expect(current.scene.items.map(i => i.part_id)).toEqual(visible);
  draft = { ...draft, groups: draft.groups.map(g => ({ ...g, xMm: g.xMm + 5 })) };
  await render(); await advance(); expect(preview).toHaveBeenCalledTimes(1);
  draft = { ...draft, groups: draft.groups.map((g, i) => i === 1 ? { ...g, recipe: { ...g.recipe!, parameters: { depth_mm: 7 } } } : g) };
  await render(); await advance();
  expect(preview).toHaveBeenCalledTimes(2);
  expect(preview.mock.calls[1][1][0]).toMatchObject({ id: 'persisted', recipe: { parameters: { depth_mm: 7 } } });
  expect(current.scene.items[1].result?.input_recipe?.parameters).toEqual({ depth_mm: 7 });
  expect(current.scene.items[0].result?.input_recipe?.parameters).toEqual({});
});

it('never shows incomplete preview responses as successful geometry and pauses while inactive', async () => {
  active = false; await render(); await advance(); expect(preview).not.toHaveBeenCalled();
  preview.mockResolvedValueOnce({ items: [] }); active = true; await render(); await advance();
  expect(current.error).toBeTruthy(); expect(current.scene.items).toEqual([]);
  draft = { ...draft, groups: draft.groups.map(g => ({ ...g, recipe: { ...g.recipe!, parameters: { depth_mm: 8 } } })) };
  await render(); await advance(); expect(current.error).toBeNull(); expect(current.scene.items).toHaveLength(300);
});

it('renders only visible sources and keeps requests at20 unique persisted identities', async () => {
  const source = { ...base.sources[0], parts: Array.from({ length: 25 }, (_, i) => ({ ...base.sources[0].parts[0], detailId: i + 1, quantity: 2 })) };
  let id = 0; base = { ...base, sources: [source], groups: createGroups([source], () => `g${++id}`) };
  draft = { ...base, groups: expandInstances(base.groups, base.sources, (g, n) => `${g}-${n}`) };
  visible = draft.groups.map(g => g.id); await render(); await advance();
  expect(preview.mock.calls.map(call => call[1].length)).toEqual([20, 5]);
  for (const call of preview.mock.calls) expect(new Set(call[1].map((g: CadGroup) => g.id)).size).toBe(call[1].length);
  expect(current.scene.items).toHaveLength(50);
});

it('previews5000 fitted same-position copies with one cached calculation', async () => {
  const source = { ...base.sources[0], parts: [{ ...base.sources[0].parts[0], quantity: 5000 }] };
  base = { ...base, sources: [source], groups: createGroups([source], () => 'persisted') };
  draft = { ...base, groups: expandInstances(base.groups, base.sources, (g, n) => `${g}-${n}`) };
  visible = draft.groups.map(g => g.id); await render(); await advance();
  expect(preview).toHaveBeenCalledTimes(1); expect(preview.mock.calls[0][1]).toHaveLength(1);
  expect(current.scene.items).toHaveLength(5000);
});
