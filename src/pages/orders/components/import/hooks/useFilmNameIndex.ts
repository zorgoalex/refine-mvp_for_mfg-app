import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { filmNameIndexApi } from '../../../../../api/filmNameIndexApi';
import { filmNameIndexState, type FilmNameIndexState } from '../utils/filmNameResolution';

/**
 * Индекс текущих и прежних названий плёнок (после импорта каталога 1С старые названия
 * из файлов заказов разрешаются в основную плёнку). Пока индекс не готов, плёнки
 * импортируемых строк автоматически не подставляются (см. useImportValidation).
 */
export function useFilmNameIndex(enabled = true): FilmNameIndexState {
  const query = useQuery({
    queryKey: ['films', 'name-index'],
    queryFn: () => filmNameIndexApi.list(),
    enabled,
    retry: 1,
    staleTime: 5 * 60_000,
  });
  const { isSuccess, isError, data } = query;
  return useMemo(() => filmNameIndexState({ isSuccess, isError, data }), [isSuccess, isError, data]);
}
