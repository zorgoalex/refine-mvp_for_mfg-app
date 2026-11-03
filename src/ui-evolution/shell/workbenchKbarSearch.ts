// «NewLine», Ctrl+K: быстрый переход ищет и записи — заказ по номеру, клиента по имени (мокап «Оболочка»).
// Встроенные действия Refine KBar (разделы, создание) остаются; найденные записи добавляются к ним
// своими секциями. Только чтение: заказы — через backend-список, клиенты — тот же список Hasura,
// что у экрана «Клиенты» (allowlist: clients read). Каждая секция — только с правом на её раздел меню.

export const KBAR_RECORD_SEARCH_MIN_LENGTH = 2;
export const KBAR_RECORD_SEARCH_LIMIT = 5;
export const KBAR_RECORD_SEARCH_DEBOUNCE_MS = 250;

export interface KbarFoundOrder {
  orderId: number;
  orderName: string;
  clientName?: string | null;
  orderStatusName?: string | null;
}

export interface KbarFoundClient {
  clientId: number;
  clientName: string;
}

export interface KbarRecordAction {
  id: string;
  name: string;
  subtitle?: string;
  keywords: string;
  section: { name: string; priority: number };
  priority: number;
  perform: () => void;
}

/** Строка поиска, по которой стоит искать записи; null — короткая или пустая. */
export function kbarRecordSearchTerm(raw: string): string | null {
  const term = raw.trim();
  return term.length >= KBAR_RECORD_SEARCH_MIN_LENGTH ? term : null;
}

/**
 * Найденные записи → действия KBar. `keywords` = сама строка поиска: KBar отбирает действия по нечёткому
 * совпадению имени/ключевых слов, а записи уже отобраны сервером — так они не пропадут из выдачи.
 */
export function buildKbarRecordActions(
  term: string,
  orders: readonly KbarFoundOrder[],
  clients: readonly KbarFoundClient[],
  open: (path: string) => void,
): KbarRecordAction[] {
  const ordersSection = { name: 'Заказы', priority: 2 };
  const clientsSection = { name: 'Клиенты', priority: 1 };
  return [
    ...orders.slice(0, KBAR_RECORD_SEARCH_LIMIT).map((order) => ({
      id: `wb-kbar-order-${order.orderId}`,
      name: `Заказ ${order.orderName}`,
      subtitle: [order.clientName, order.orderStatusName].filter(Boolean).join(' · ') || undefined,
      keywords: term,
      section: ordersSection,
      priority: 2,
      perform: () => open(`/orders/show/${order.orderId}`),
    })),
    ...clients.slice(0, KBAR_RECORD_SEARCH_LIMIT).map((client) => ({
      id: `wb-kbar-client-${client.clientId}`,
      name: client.clientName,
      subtitle: 'Клиент',
      keywords: term,
      section: clientsSection,
      priority: 1,
      perform: () => open(`/clients/show/${client.clientId}`),
    })),
  ];
}
