import type { OrderHdfDetail } from '../../../../types/orders';

/** How the HDF tab names the state of a calculation. */
export const HDF_STATUS_LABELS: Record<string, { label: string; color: string }> = {
  ok: { label: 'Рассчитано', color: 'green' },
  too_narrow: { label: 'ХДФ слишком узкий', color: 'red' },
  config_missing: { label: 'Нет настройки', color: 'orange' },
  source_changed: { label: 'Исходная деталь изменилась', color: 'volcano' },
};

export const HDF_CONFIG_SETTINGS_LOCATION = 'Конфигурация -> Пороги техпроцессов -> ХДФ';

const CONFIG_ERROR_LABELS: Record<string, string> = {
  missing_threshold: 'не задана минимальная сторона ХДФ',
  missing_hdf_sheet_material: 'не выбран листовой материал ХДФ',
  missing_config_revision: 'нет ревизии настроек ХДФ',
};

export function describeHdfConfigErrors(errors: ReadonlyArray<string> | null | undefined): string[] {
  return Array.from(new Set(errors ?? []))
    .map((error) => CONFIG_ERROR_LABELS[error] ?? error)
    .filter(Boolean);
}

export function collectHdfConfigErrorDescriptions(details: ReadonlyArray<OrderHdfDetail>): string[] {
  const errors = details.flatMap((detail) => (
    detail.status === 'config_missing' ? describeHdfConfigErrors(detail.config_errors) : []
  ));
  return Array.from(new Set(errors));
}
