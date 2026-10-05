import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sheetMaterialsApi, type SheetMaterialTypeDto } from '../../api/sheetMaterialsApi';

/** Backend знает тип/категорию номенклатуры и примечание: отдельный запрос возможностей — не зависит от наличия записей. */
export function useSheetMaterialCapabilities(enabled = true): { supported: boolean; onecItemPicker: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ['sheet-materials', 'capabilities'],
    queryFn: () => sheetMaterialsApi.capabilities(),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return { supported: query.data?.nomenclatureFields === true, onecItemPicker: query.data?.onecItemPicker === true, isLoading: enabled && query.isLoading };
}

/**
 * Тип/категория номенклатуры и примечание листовых материалов читаются через backend, не Hasura: при смешанной
 * выкладке (новый FE, ещё старая схема) запрос Hasura с новыми колонками сломал бы список и форму заказа.
 */
export function useSheetMaterialNomenclature(enabled = true) {
  const capabilities = useSheetMaterialCapabilities(enabled);
  const query = useQuery({
    queryKey: ['sheet-materials', 'nomenclature'],
    queryFn: () => sheetMaterialsApi.list(true),
    enabled: enabled && capabilities.supported,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const items: SheetMaterialTypeDto[] = query.data ?? [];
    return {
      supported: capabilities.supported,
      byId: new Map(items.map((item) => [item.sheetMaterialTypeId, item])),
      refetch: query.refetch,
    };
  }, [capabilities.supported, query.data, query.refetch]);
}
