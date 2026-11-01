import type { PermissionName } from '../../permissions/permissions';

export const CLIENT_MERGE: PermissionName = 'clients.merge';
export const SOURCE = 'client_merge';
/** A merge can be undone during this term; afterwards the personal data of its journal is erased. */
export const UNDO_TERM_DAYS = 30;
/** A client with more orders is merged by hand in parts (now the largest has 146). */
export const MAX_ORDERS = 1000;
/** The contacts limit of a client (`PARTY_OWN_CONTACTS_MAX`): a merge that would go over it is refused. */
export const MAX_CONTACTS = 20;
/** Attempts of a merge or an undo whose locked set changed under it (a row appeared between the locks). */
export const LOCK_ATTEMPTS = 3;

/** Why a merge or an undo cannot be done; each is shown to the user with its text. */
export const OBSTACLES = {
  CASE_NOT_OPEN: 'Дело уже не открыто',
  NOT_CASE_MEMBERS: 'Клиент не участник этого дела',
  CLIENT_INACTIVE: 'Клиент неактивен',
  CLIENT_ALREADY_MERGED: 'Клиент уже объединён с другим',
  ONEC_LINK_CONFLICT: 'Оба клиента связаны с разными контрагентами 1С: сначала снимите одну связь в карточке клиента',
  BITRIX_REQUESTS: 'У объединяемого клиента есть заявки Bitrix24: такие клиенты пока не объединяются',
  BITRIX_ALIAS_REQUESTS: 'После объединения в Bitrix24 появились сделки на контакте объединённого клиента: отмена недоступна',
  WHATSAPP_PENDING: 'Есть незавершённые отправки WhatsApp по заказам или телефонам клиента: дождитесь их окончания',
  GROUP_LINKS: 'Клиент связан с группами доступа: сначала перенесите или закройте эти связи',
  CLIENT_DEADLINES: 'У клиента есть сроки без заказа: такие клиенты пока не объединяются',
  CONTACTS_LIMIT: 'После объединения у клиента будет больше 20 контактов: удалите лишние в карточке',
  TOO_MANY_ROWS: 'У клиента слишком много заказов для одного объединения',
  ORDERS_NOT_PERMITTED: 'Есть заказы, которые вы не можете изменять',
  PROJECTS_NOT_PERMITTED: 'Нет права изменять группы заказов',
  CLIENTS_NOT_PERMITTED: 'Нет права изменять клиентов (телефоны и контакты)',
  ONEC_LINK_NOT_PERMITTED: 'Нет права менять связь клиента с 1С',
  BAZIS_CARDS_NOT_PERMITTED: 'Нет права изменять Базис-проекты клиента (их клиент меняется вместе с заказами)',
  UNDO_ORDER: 'Сначала отмените более позднее объединение с участием этих клиентов',
  UNDO_ONEC_LINK_CONFLICT: 'Остающийся клиент уже связан с другим контрагентом 1С',
  UNDO_MERGED_LINKED: 'Объединённый клиент уже связан с контрагентом 1С',
  UNDO_BAZIS_CARD_SPLIT: 'Базис-проект связывает заказы, которые вернутся, и заказы, которые останутся: сначала отвяжите их в карточке Базис-проекта',
} as const;
export type ObstacleCode = keyof typeof OBSTACLES;

export interface Obstacle {
  code: ObstacleCode;
  message: string;
}

export const obstacle = (code: ObstacleCode): Obstacle => ({ code, message: OBSTACLES[code] });

export const MERGE_ITEM_KINDS = [
  'project', 'order', 'phone_moved', 'phone_deleted', 'phone_key_moved', 'phone_primary',
  'contact_moved', 'contact_deleted', 'contact_primary', 'onec_link', 'redirect_repointed', 'bazis_card',
] as const;
export type MergeItemKind = (typeof MERGE_ITEM_KINDS)[number];

/** Kinds whose `before`/`after` hold personal data (numbers, contact values, notes): erased after the undo term. */
export const PERSONAL_ITEM_KINDS: readonly MergeItemKind[] = [
  'phone_moved', 'phone_deleted', 'phone_key_moved', 'phone_primary', 'contact_moved', 'contact_deleted', 'contact_primary',
];

export interface MergeContext {
  requestId: string;
  correlationId: string;
}
