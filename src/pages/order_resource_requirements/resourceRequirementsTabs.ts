export type ResourceRequirementsTab = 'demand' | 'supply';

/** Вкладка из адреса: «Экран снабжения» только когда он доступен, иначе — «Потребность заказов». */
export function resolveSupplyTab(value: string | null, available: boolean): ResourceRequirementsTab {
  return value === 'supply' && available ? 'supply' : 'demand';
}
