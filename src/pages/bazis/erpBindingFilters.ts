/**
 * Взаимосвязанные поля шага «Привязка» визарда импорта (режим «Существующий
 * ERP-проект»): клиент ↔ ERP-проект ↔ ERP-заказ. Выбор в любом поле сужает
 * остальные; сброс поля снимает только его собственное значение.
 *
 * Чистые функции без React/DOM — тестируются в node-окружении.
 */

export interface ErpBindingProject {
  projectId: number;
  code: string;
  name: string;
  clientId: number;
  clientName?: string;
}

export interface ErpBindingOrder {
  orderId: number;
  projectId: number | null;
  clientId: number | null;
}

export interface ErpBindingState {
  clientId: number | undefined;
  projectId: number | undefined;
  orderId: number | undefined;
}

export function clientOptionsFromProjects(
  projects: readonly ErpBindingProject[],
): Array<{ value: number; label: string }> {
  const seen = new Map<number, string>();
  for (const project of projects) {
    if (!seen.has(project.clientId)) {
      seen.set(project.clientId, project.clientName?.trim() || `Клиент #${project.clientId}`);
    }
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }));
}

export function filterProjectOptions(
  projects: readonly ErpBindingProject[],
  state: ErpBindingState,
): ErpBindingProject[] {
  return projects.filter(
    (project) => state.clientId === undefined || project.clientId === state.clientId,
  );
}

export function nextBindingOnOrderPick(
  state: ErpBindingState,
  order: ErpBindingOrder | undefined,
): ErpBindingState {
  if (!order) {
    return { ...state, orderId: undefined };
  }
  return {
    orderId: order.orderId,
    projectId: order.projectId ?? state.projectId,
    clientId: order.clientId ?? state.clientId,
  };
}

export function nextBindingOnProjectPick(
  state: ErpBindingState,
  project: ErpBindingProject | undefined,
  selectedOrder: ErpBindingOrder | undefined,
): ErpBindingState {
  if (!project) {
    return { ...state, projectId: undefined };
  }
  const orderMatches =
    state.orderId !== undefined && selectedOrder?.projectId === project.projectId;
  return {
    clientId: project.clientId,
    projectId: project.projectId,
    orderId: orderMatches ? state.orderId : undefined,
  };
}

export function nextBindingOnClientPick(
  state: ErpBindingState,
  clientId: number | undefined,
  projects: readonly ErpBindingProject[],
  selectedOrder: ErpBindingOrder | undefined,
): ErpBindingState {
  if (clientId === undefined) {
    return { ...state, clientId: undefined };
  }
  const projectMatches =
    state.projectId !== undefined &&
    projects.some((p) => p.projectId === state.projectId && p.clientId === clientId);
  const orderMatches = state.orderId !== undefined && selectedOrder?.clientId === clientId;
  return {
    clientId,
    projectId: projectMatches ? state.projectId : undefined,
    orderId: orderMatches ? state.orderId : undefined,
  };
}
