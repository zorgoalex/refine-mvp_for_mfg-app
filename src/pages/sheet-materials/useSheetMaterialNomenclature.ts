import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sheetMaterialsApi, type SheetMaterialTypeDto } from '../../api/sheetMaterialsApi';
import { supportsNomenclature } from '../../components/NomenclatureFields';

/**
 * Тип/категория номенклатуры и примечание листовых материалов читаются через backend, не Hasura: при смешанной
 * выкладке (новый FE, ещё старая схема) запрос Hasura с новыми колонками сломал бы список и форму заказа.
 */
export function useSheetMaterialNomenclature(enabled = true) {
  const query = useQuery({
    queryKey: ['sheet-materials', 'nomenclature'],
    queryFn: () => sheetMaterialsApi.list(true),
    enabled,
    staleTime: 30_000,
  });
  return useMemo(() => {
    const items: SheetMaterialTypeDto[] = query.data ?? [];
    return {
      supported: items.some((item) => supportsNomenclature(item)),
      byId: new Map(items.map((item) => [item.sheetMaterialTypeId, item])),
      refetch: query.refetch,
    };
  }, [query.data, query.refetch]);
}
