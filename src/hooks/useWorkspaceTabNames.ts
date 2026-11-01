// Имена вкладок записей, которые страница ещё не назвала сама: вкладка открыта в фоне или восстановлена после
// перезагрузки и называется по адресу («Клиенты · Просмотр»). Запись читается один раз, и вкладка получает имя
// (номер заказа, имя клиента, название справочника…); номер записи в базе в название не попадает. Открытую
// вкладку называет её страница; если за ACTIVE_TAB_GRACE_MS не назвала — называем сами.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useDataProvider, useResource } from '@refinedev/core';
import { useTabStore } from '../stores/tabStore';
import {
  bazisCutSetTabLabel,
  RESOURCE_LABELS,
  resolveOrderTabLabel,
  resourceFromPath,
  tabLabelNeedsName,
} from '../utils/tabLabels';
import { buildRecordTabTitle, pickRecordTitle } from '../utils/recordTitle';
import { authSession } from '../api/authSession';
import { projectsApi } from '../api/projectsApi';
import { bazisCutApi } from '../api/bazisCutApi';
import { bazisApi } from '../api/bazisApi';
import { ordersApi } from '../api/ordersApi';
import { onecDocumentsApi } from '../api/onecDocumentsApi';

const ACTION_LABELS: Record<string, string> = { show: 'Просмотр', edit: 'Редактирование' };
export const MAX_PARALLEL_TAB_NAME_READS = 3;
export const ACTIVE_TAB_GRACE_MS = 3000;

type GetOne = (resource: string, id: string, meta?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

interface ResourceRoutes {
  name: string;
  show?: unknown;
  edit?: unknown;
  meta?: Record<string, unknown>;
}

const routeOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Ресурс refine, чей маршрут show/edit с `:id` совпадает с адресом вкладки (`/clients/show/:id` ↔ `/clients/show/2606`). */
export function matchResourceRoute(
  resources: readonly ResourceRoutes[],
  key: string,
): { resource: ResourceRoutes; action: 'show' | 'edit'; id: string } | null {
  for (const resource of resources) {
    for (const action of ['show', 'edit'] as const) {
      const route = routeOf(resource[action]);
      if (!route || !route.endsWith('/:id')) continue;
      const prefix = route.slice(0, -':id'.length);
      if (key.startsWith(prefix)) {
        const id = key.slice(prefix.length);
        if (/^\d+$/.test(id)) return { resource, action, id };
      }
    }
  }
  return null;
}

/** Имя вкладки записи по её адресу; null — имени нет (запись не найдена, нет прав, у записи нет имени). */
export async function loadTabName(
  key: string,
  resources: readonly ResourceRoutes[],
  getOne: GetOne,
): Promise<string | null> {
  const cad = key.match(/^\/cad\/orders\/(\d+)$/);
  const order = key.match(/^\/orders\/(show|edit)\/(\d+)$/);
  if (order || cad) {
    const record = await getOne('orders_view', (order ? order[2] : cad![1]), { idColumnName: 'order_id' });
    const name = typeof record?.order_name === 'string' ? record.order_name.trim() : '';
    if (!name) return null;
    return cad ? `CAD · заказ ${name}` : resolveOrderTabLabel(name);
  }
  const demand = key.match(/^\/order-resource-requirements\/show\/(\d+)$/);
  if (demand) {
    const card = await ordersApi.getResourceDemandCard(Number(demand[1]));
    const name = card?.data?.orderName?.trim();
    return name ? `${RESOURCE_LABELS.order_resource_requirements} · Просмотр · ${name}` : null;
  }
  const onecDocument = key.match(/^\/procurement\/onec-documents\/show\/(\d+)$/);
  if (onecDocument) {
    const card = await onecDocumentsApi.getCard(Number(onecDocument[1]));
    const number = card?.data?.number?.trim();
    return number ? `${RESOURCE_LABELS.onec_purchase_documents} · Просмотр · ${number}` : null;
  }
  const project = key.match(/^\/projects\/show\/(\d+)$/);
  if (project) {
    const card = await projectsApi.getById(Number(project[1]));
    const code = card?.code?.trim() || card?.name?.trim();
    return code ? `${RESOURCE_LABELS.projects} · Просмотр · ${code}` : null;
  }
  const cutSet = key.match(/^\/bazis-cut\/(\d+)$/);
  if (cutSet) {
    const set = await bazisCutApi.get(Number(cutSet[1]));
    return set?.name?.trim() ? bazisCutSetTabLabel(set.name) : null;
  }
  const bazisProject = key.match(/^\/bazis\/projects\/(\d+)$/);
  if (bazisProject) {
    const card = await bazisApi.getProject(Number(bazisProject[1]));
    return card?.name?.trim() ? `БП ${card.name.trim()}` : null;
  }
  const matched = matchResourceRoute(resources, key);
  if (!matched) return null;
  const record = await getOne(matched.resource.name, matched.id, matched.resource.meta);
  if (!pickRecordTitle(record)) return null;
  const resourceKey = resourceFromPath(key);
  const resourceLabel = (resourceKey ? RESOURCE_LABELS[resourceKey] : undefined)
    ?? (typeof matched.resource.meta?.label === 'string' ? matched.resource.meta.label : matched.resource.name);
  return buildRecordTabTitle({ resourceLabel, actionLabel: ACTION_LABELS[matched.action], record });
}

export interface TabSnapshot {
  key: string;
  label: string;
}

/**
 * Очередь имён вкладок без React: что прочитать (не больше MAX_PARALLEL_TAB_NAME_READS одновременно, каждую
 * вкладку — один раз за сессию), когда перепроверить открытую вкладку и можно ли применить пришедшее имя (та же
 * сессия, вкладку за это время не переименовали). Названия не стирает никогда: старые названия с номером записи
 * убирает один раз миграция сохранённых вкладок (`migrateWorkspaceTabs`, версия 2), а здесь имя только
 * подставляется вместо названия по адресу.
 */
export class TabNameQueue {
  private tried = new Set<string>();
  private running = 0;
  private session: string | null = null;
  private activeSince: { key: string; since: number } | null = null;

  /** Смена пользователя или сессии: попытки прошлой сессии не в счёт, их ответы не применяются. */
  syncSession(session: string): void {
    if (this.session === session) return;
    this.session = session;
    this.tried = new Set();
    this.activeSince = null;
  }

  plan(tabs: readonly TabSnapshot[], activeKey: string, now: number): {
    load: TabSnapshot[];
    recheckInMs: number | null;
  } {
    const wanted = (tab: TabSnapshot) => !this.tried.has(tab.key) && tabLabelNeedsName(tab.key, tab.label);
    const candidates = tabs.filter((tab) => tab.key !== activeKey && wanted(tab));
    let recheckInMs: number | null = null;
    const active = tabs.find((tab) => tab.key === activeKey);
    if (active && wanted(active)) {
      if (this.activeSince?.key !== active.key) this.activeSince = { key: active.key, since: now };
      const waited = now - this.activeSince.since;
      if (waited >= ACTIVE_TAB_GRACE_MS) candidates.push(active);
      else recheckInMs = ACTIVE_TAB_GRACE_MS - waited;
    }
    const free = Math.max(0, MAX_PARALLEL_TAB_NAME_READS - this.running);
    const load = candidates.slice(0, free).map((tab) => ({ key: tab.key, label: tab.label }));
    for (const tab of load) {
      this.tried.add(tab.key);
      this.running += 1;
    }
    return { load, recheckInMs };
  }

  finish(): void {
    this.running = Math.max(0, this.running - 1);
  }

  /** Применить имя: та же сессия, что при запросе, и вкладку никто не переименовал (имя страницы главнее). */
  canApply(startedSession: string, startedLabel: string, currentLabel: string | undefined): boolean {
    return this.session === startedSession && currentLabel === startedLabel;
  }
}

const currentSession = (): string => `${authSession.getSessionGeneration()}:${authSession.getUser()?.id ?? ''}`;

export const useWorkspaceTabNames = (): void => {
  const location = useLocation();
  const tabs = useTabStore((state) => state.tabs);
  const setTabTitle = useTabStore((state) => state.setTabTitle);
  const { resources } = useResource();
  const dataProvider = useDataProvider();
  const queueRef = useRef(new TabNameQueue());
  const mountedRef = useRef(true);
  // после каждого чтения и по таймеру открытой вкладки — новый проход очереди
  const [round, setRound] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const queue = queueRef.current;
    const session = currentSession();
    queue.syncSession(session);
    const getOne: GetOne = async (resource, id, meta) => {
      const response = await dataProvider().getOne({ resource, id, meta });
      return (response?.data ?? null) as Record<string, unknown> | null;
    };
    const { load, recheckInMs } = queue.plan(tabs, location.pathname, Date.now());
    for (const tab of load) {
      void loadTabName(tab.key, resources as readonly ResourceRoutes[], getOne)
        .then((name) => {
          if (!name || !mountedRef.current) return;
          const current = useTabStore.getState().tabs.find((item) => item.key === tab.key);
          if (queue.canApply(session, tab.label, current?.label) && session === currentSession()) setTabTitle(tab.key, name);
        })
        .catch(() => undefined)
        .finally(() => {
          queue.finish();
          if (mountedRef.current) setRound((value) => value + 1);
        });
    }
    const timer = recheckInMs === null ? undefined : globalThis.setTimeout(() => setRound((value) => value + 1), recheckInMs);
    return () => globalThis.clearTimeout(timer);
  }, [dataProvider, location.pathname, resources, round, setTabTitle, tabs]);
};
