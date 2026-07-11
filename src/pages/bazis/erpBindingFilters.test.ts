import { describe, expect, it } from 'vitest';
import {
  clientOptionsFromProjects,
  filterProjectOptions,
  nextBindingOnClientPick,
  nextBindingOnOrderPick,
  nextBindingOnProjectPick,
  type ErpBindingOrder,
  type ErpBindingProject,
  type ErpBindingState,
} from './erpBindingFilters';

const projects: ErpBindingProject[] = [
  { projectId: 1, code: 'ФК1', name: 'Кухня', clientId: 10, clientName: 'Иванов' },
  { projectId: 2, code: 'ФК2', name: 'Шкаф', clientId: 10, clientName: 'Иванов' },
  { projectId: 3, code: 'ФК3', name: 'Санузел', clientId: 20, clientName: 'Петров' },
];

const order = (over: Partial<ErpBindingOrder>): ErpBindingOrder => ({
  orderId: 100,
  projectId: 1,
  clientId: 10,
  ...over,
});

const empty: ErpBindingState = { clientId: undefined, projectId: undefined, orderId: undefined };

describe('erpBindingFilters', () => {
  it('client options are derived from projects and deduplicated', () => {
    expect(clientOptionsFromProjects(projects)).toEqual([
      { value: 10, label: 'Иванов' },
      { value: 20, label: 'Петров' },
    ]);
  });

  it('project options narrow by selected client', () => {
    expect(filterProjectOptions(projects, { ...empty, clientId: 20 }).map((p) => p.projectId)).toEqual([3]);
    expect(filterProjectOptions(projects, empty).map((p) => p.projectId)).toEqual([1, 2, 3]);
  });

  it('picking an order pins its project and client', () => {
    const next = nextBindingOnOrderPick(empty, order({ orderId: 555, projectId: 2, clientId: 10 }));
    expect(next).toEqual({ clientId: 10, projectId: 2, orderId: 555 });
  });

  it('picking a project pins its client and drops an order from another project', () => {
    const state: ErpBindingState = { clientId: undefined, projectId: undefined, orderId: 555 };
    const next = nextBindingOnProjectPick(state, projects[2], order({ orderId: 555, projectId: 1 }));
    expect(next).toEqual({ clientId: 20, projectId: 3, orderId: undefined });
  });

  it('picking a project keeps an order that belongs to it', () => {
    const state: ErpBindingState = { clientId: 10, projectId: undefined, orderId: 555 };
    const next = nextBindingOnProjectPick(state, projects[0], order({ orderId: 555, projectId: 1 }));
    expect(next).toEqual({ clientId: 10, projectId: 1, orderId: 555 });
  });

  it('picking a client drops project and order of another client', () => {
    const state: ErpBindingState = { clientId: undefined, projectId: 3, orderId: 555 };
    const next = nextBindingOnClientPick(state, 10, projects, order({ orderId: 555, clientId: 20, projectId: 3 }));
    expect(next).toEqual({ clientId: 10, projectId: undefined, orderId: undefined });
  });

  it('picking a client keeps matching project and order', () => {
    const state: ErpBindingState = { clientId: undefined, projectId: 1, orderId: 555 };
    const next = nextBindingOnClientPick(state, 10, projects, order({ orderId: 555, clientId: 10, projectId: 1 }));
    expect(next).toEqual({ clientId: 10, projectId: 1, orderId: 555 });
  });

  it('clearing a field (undefined) only clears that field', () => {
    const state: ErpBindingState = { clientId: 10, projectId: 1, orderId: 555 };
    expect(nextBindingOnClientPick(state, undefined, projects, order({}))).toEqual({
      clientId: undefined,
      projectId: 1,
      orderId: 555,
    });
    expect(nextBindingOnProjectPick(state, undefined, order({}))).toEqual({
      clientId: 10,
      projectId: undefined,
      orderId: 555,
    });
    expect(nextBindingOnOrderPick(state, undefined)).toEqual({
      clientId: 10,
      projectId: 1,
      orderId: undefined,
    });
  });
});
