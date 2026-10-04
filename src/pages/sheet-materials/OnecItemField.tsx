import React from 'react';
import { Input, Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { sheetMaterialsApi, type OnecItemOption } from '../../api/sheetMaterialsApi';
import { useSheetMaterialCapabilities } from './useSheetMaterialNomenclature';

export interface OnecItemSelectOption { value: string; label: string; disabled: boolean; item: OnecItemOption | null }

/**
 * Варианты поля «Позиция 1С»: название, код, единица и категория — по ним идёт поиск. Позиция, уже привязанная к
 * другому листовому материалу, недоступна для выбора. Текущий ключ, которого нет в данных 1С, остаётся в списке.
 */
export function onecItemOptions(items: readonly OnecItemOption[], sheetId: number | null, current: string | null | undefined): OnecItemSelectOption[] {
  const options: OnecItemSelectOption[] = items.map((item) => {
    const taken = item.linkedSheetMaterialTypeId !== null && item.linkedSheetMaterialTypeId !== sheetId;
    const parts = [item.name, item.code, item.unitName, item.categoryName].filter(Boolean).join(' · ');
    return {
      value: item.refKey,
      label: `${parts}${item.deletionMark ? ' · помечена на удаление' : ''}${taken ? ` — привязана к «${item.linkedName}»` : ''}`,
      disabled: taken,
      item,
    };
  });
  const key = current?.trim().toLowerCase();
  if (key && !options.some((option) => option.value === key)) {
    options.unshift({ value: key, label: `${key} — нет в данных 1С`, disabled: false, item: null });
  }
  return options;
}

/**
 * Поле формы листового материала: выбор позиции номенклатуры 1С из списка с поиском. Если backend списка не умеет
 * или данных 1С нет — ключ вводится вручную, как раньше. Значение поля — ключ позиции (UUID); очистка даёт ''.
 */
export const OnecItemField: React.FC<{
  value?: string | null;
  onChange?: (value: string) => void;
  /** Редактируемый материал: позиция, привязанная к нему самому, остаётся доступной. */
  sheetId?: number | null;
  /** Выбрана позиция из списка — форма может подставить тип и категорию номенклатуры. */
  onPick?: (item: OnecItemOption) => void;
}> = ({ value, onChange, sheetId = null, onPick }) => {
  const capabilities = useSheetMaterialCapabilities();
  const query = useQuery({
    queryKey: ['sheet-materials', 'onec-items'],
    queryFn: () => sheetMaterialsApi.onecItems(),
    enabled: capabilities.onecItemPicker,
    retry: false,
    staleTime: 60_000,
  });
  if (capabilities.isLoading || (capabilities.onecItemPicker && query.isLoading)) return <Select loading disabled placeholder="Загрузка позиций 1С…" />;
  if (!capabilities.onecItemPicker || !query.data?.available) {
    return <Input maxLength={36} placeholder="UUID из 1С" allowClear value={value ?? ''} onChange={(event) => onChange?.(event.target.value)} />;
  }
  const options = onecItemOptions(query.data.items, sheetId, value);
  return (
    <Select
      showSearch
      allowClear
      optionFilterProp="label"
      placeholder="Выберите позицию 1С"
      value={value ? value.trim().toLowerCase() : undefined}
      options={options.map(({ value: key, label, disabled }) => ({ value: key, label, disabled }))}
      onChange={(next?: string) => {
        onChange?.(next ?? '');
        const picked = options.find((option) => option.value === next)?.item;
        if (picked) onPick?.(picked);
      }}
    />
  );
};
