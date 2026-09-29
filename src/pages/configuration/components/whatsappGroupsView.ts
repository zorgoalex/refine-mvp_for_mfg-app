import { isApiError } from '../../../api/apiError';
import type { WhatsAppGroupDto } from '../../../api/types/whatsappApi.types';

export const UNNAMED_GROUP_LABEL = 'Без названия';

export interface GroupWarning {
  key: 'announceOnly' | 'communityParent' | 'suspended';
  label: string;
  text: string;
}

export function groupDisplayName(group: Pick<WhatsAppGroupDto, 'name'>): string {
  const name = group.name?.trim();
  return name ? name : UNNAMED_GROUP_LABEL;
}

export function filterGroups(groups: WhatsAppGroupDto[], query: string): WhatsAppGroupDto[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups.filter(
    (group) => (group.name ?? '').toLowerCase().includes(needle) || group.id.toLowerCase().includes(needle),
  );
}

export function groupWarnings(group: WhatsAppGroupDto): GroupWarning[] {
  const result: GroupWarning[] = [];
  if (group.announceOnly) {
    result.push({
      key: 'announceOnly',
      label: 'Только админы',
      text: 'Пишут только администраторы: отправка сработает, только если подключённый аккаунт — администратор',
    });
  }
  if (group.communityParent) {
    result.push({
      key: 'communityParent',
      label: 'Сообщество',
      text: 'Сообщество: обычные сообщения сюда не отправляются, выберите группу внутри сообщества',
    });
  }
  if (group.suspended) {
    result.push({ key: 'suspended', label: 'Заблокирована', text: 'Группа заблокирована WhatsApp' });
  }
  return result;
}

export function findGroupById(groups: WhatsAppGroupDto[], id: string | null | undefined): WhatsAppGroupDto | undefined {
  const needle = (id ?? '').trim();
  if (!needle) return undefined;
  return groups.find((group) => group.id === needle);
}

export function groupsErrorText(error: unknown): string {
  if (!isApiError(error)) {
    return error instanceof TypeError
      ? 'Нет соединения с backend. Проверьте сеть и повторите.'
      : 'Не удалось загрузить список групп.';
  }
  switch (error.code) {
    case 'WHATSAPP_SESSION_NOT_READY':
      return 'WhatsApp не подключён: привяжите аккаунт на вкладке «WhatsApp» → «Подключение»';
    case 'WHATSAPP_NOT_CONFIGURED':
      return 'Интеграция WhatsApp выключена или не настроена на сервере';
    case 'WAHA_UNAVAILABLE':
      return 'Сервис WAHA недоступен, повторите позже';
    case 'WAHA_PROVIDER_ERROR':
      return 'WAHA не смог получить список групп, повторите позже';
    case 'WHATSAPP_GROUPS_QUERY_INVALID':
      return 'Некорректный запрос списка групп';
    case 'PERMISSION_DENIED':
      return 'Нет права whatsapp.manage для просмотра групп';
    default:
      if (error.status === 403) return 'Нет права whatsapp.manage для просмотра групп';
      if (error.status >= 500) return 'Сервис временно недоступен, повторите позже';
      return 'Не удалось загрузить список групп.';
  }
}

export function formatFetchedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
