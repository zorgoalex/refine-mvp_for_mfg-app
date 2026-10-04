import { useGetIdentity } from '@refinedev/core';

const VIEW_PERMISSION = 'procurement.view';
const MANAGE_PERMISSION = 'procurement.manage';
const FINANCE_PERMISSION = 'finance.view';

export interface OnecDocumentsPermissions {
  canView: boolean;
  canManage: boolean;
  canSeeAmounts: boolean;
}

/** Чистая функция — тестируется без монтирования хука/React. */
export function computeOnecDocumentsPermissions(permissions: string[] | undefined): OnecDocumentsPermissions {
  const list = permissions ?? [];
  return {
    canView: list.includes(VIEW_PERMISSION),
    canManage: list.includes(MANAGE_PERMISSION),
    canSeeAmounts: list.includes(FINANCE_PERMISSION),
  };
}

/**
 * Права экрана «Документы 1С»: `procurement.view` (экран/чтение),
 * `procurement.manage` (распределения), `finance.view` (суммы и оплаты).
 * Пока identity грузится — считаем права отсутствующими, но вызывающая
 * сторона обязана держать контролы disabled по `loading`, а не трактовать
 * это состояние как «нет права».
 */
export function useOnecDocumentsPermissions(): OnecDocumentsPermissions & { loading: boolean } {
  const { data: identity, isLoading } = useGetIdentity<{ permissions?: string[] }>();
  return { ...computeOnecDocumentsPermissions(identity?.permissions), loading: isLoading };
}
