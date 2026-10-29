export type IntegrationTabKey = 'duplicates' | 'onec' | 'bitrix';

export interface IntegrationTab { key: IntegrationTabKey; label: string }

/** Tabs of «Интеграции» the user may see; «Дубли» is always first. */
export function integrationTabs(access: { canDuplicates: boolean; canOnec: boolean; canBitrix: boolean }): IntegrationTab[] {
  const tabs: IntegrationTab[] = [];
  if (access.canDuplicates) tabs.push({ key: 'duplicates', label: 'Дубли' });
  if (access.canOnec) tabs.push({ key: 'onec', label: '1С' });
  if (access.canBitrix) tabs.push({ key: 'bitrix', label: 'Bitrix24' });
  return tabs;
}
