import React, { useEffect, useLayoutEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import type { ReferenceData, ValidatedRow } from '../types/importTypes';
import { useImportValidation, type UseImportValidationReturn } from './useImportValidation';

// Порядок эффектов модалки при восстановлении черновика (code review R5-2): строки
// восстанавливаются в useLayoutEffect, справочники приходят в passive effect модалки —
// уже после первого passive effect хука валидации.

const pendingRow = (filmName: string): ValidatedRow => ({
  filmName,
  height: 100,
  width: 100,
  quantity: 1,
  film_id: null,
  filmPendingIndex: true,
  isValid: true,
  errors: [],
  warnings: [{
    field: 'film',
    type: 'warning',
    message: `Проверяются прежние названия плёнок для "${filmName}" — плёнка будет подставлена после проверки`,
  }],
});

const films = [{ id: 77, name: 'Орех' }, { id: 5, name: 'Белый' }];
const index = [
  { name: 'Орех Милано; Гульсум', filmId: 42, canonicalFilmId: 42, vendorId: 1, active: true, source: 'current' as const },
  { name: 'Орех', filmId: 42, canonicalFilmId: 42, vendorId: 1, active: true, source: 'history' as const },
  { name: 'Орех', filmId: 77, canonicalFilmId: 77, vendorId: 2, active: true, source: 'current' as const },
  { name: 'Белый', filmId: 5, canonicalFilmId: 5, vendorId: 1, active: true, source: 'current' as const },
];
const refData = (status: 'loading' | 'ready', withFilms: boolean): ReferenceData => ({
  edgeTypes: [],
  films: withFilms ? films : [],
  filmNameIndex: status === 'ready' ? index : [],
  filmNameIndexStatus: status,
  millingTypes: [],
  sheetMaterialTypes: [],
});

function Harness({
  restored,
  referenceData,
  onSnapshot,
}: {
  restored: ValidatedRow[];
  referenceData: ReferenceData | null;
  onSnapshot: (snapshot: UseImportValidationReturn) => void;
}) {
  const validation = useImportValidation();
  const { restoreValidatedRows, setReferenceData } = validation;
  // Восстановление черновика при монтировании, как в модалках (restored не меняется).
  useLayoutEffect(() => {
    restoreValidatedRows(restored);
  }, [restoreValidatedRows, restored]);
  useEffect(() => {
    if (referenceData) setReferenceData(referenceData);
  }, [referenceData, setReferenceData]);
  onSnapshot(validation);
  return null;
}

describe('restored import draft keeps films pending until reference data is ready', () => {
  it('does not settle pending films on the initial empty reference data', async () => {
    let latest!: UseImportValidationReturn;
    const onSnapshot = (snapshot: UseImportValidationReturn) => {
      latest = snapshot;
    };
    const restored = [pendingRow('Орех'), pendingRow('Белый')];
    let view!: ReturnType<typeof TestRenderer.create>;

    // Модалка ещё не передала справочники.
    await act(async () => {
      view = TestRenderer.create(<Harness restored={restored} referenceData={null} onSnapshot={onSnapshot} />);
    });
    expect(latest.validatedRows.map((row) => [row.film_id, row.filmPendingIndex])).toEqual([[null, true], [null, true]]);
    expect(latest.filmIndexLoading).toBe(true);

    // Справочник плёнок ещё грузится — модалка передаёт статус loading.
    const loading = refData('loading', false);
    await act(async () => {
      view.update(<Harness restored={restored} referenceData={loading} onSnapshot={onSnapshot} />);
    });
    expect(latest.validatedRows.every((row) => row.filmPendingIndex && row.film_id === null)).toBe(true);
    expect(latest.filmIndexLoading).toBe(true);

    // Индекс и справочник готовы: отложенные строки пересчитываются.
    const ready = refData('ready', true);
    await act(async () => {
      view.update(<Harness restored={restored} referenceData={ready} onSnapshot={onSnapshot} />);
    });
    expect(latest.validatedRows[0]).toMatchObject({ film_id: null, filmPendingIndex: false });
    expect(latest.validatedRows[0].warnings.map(({ message }) => message)).toEqual([
      'Найдено несколько канонических плёнок для "Орех". Выберите вручную.',
    ]);
    expect(latest.validatedRows[1]).toMatchObject({ film_id: 5, filmPendingIndex: false, warnings: [] });
    expect(latest.filmIndexLoading).toBe(false);

    await act(async () => {
      view.unmount();
    });
  });

  it('keeps a manual film choice made while the index was loading', async () => {
    let latest!: UseImportValidationReturn;
    const onSnapshot = (snapshot: UseImportValidationReturn) => {
      latest = snapshot;
    };
    const restored = [pendingRow('Белый')];
    let view!: ReturnType<typeof TestRenderer.create>;
    const loading = refData('loading', true);
    await act(async () => {
      view = TestRenderer.create(<Harness restored={restored} referenceData={loading} onSnapshot={onSnapshot} />);
    });
    await act(async () => {
      latest.updateRow(0, 'film_id', 77);
    });
    const ready = refData('ready', true);
    await act(async () => {
      view.update(<Harness restored={restored} referenceData={ready} onSnapshot={onSnapshot} />);
    });
    expect(latest.validatedRows[0]).toMatchObject({ film_id: 77, filmPendingIndex: false });
    await act(async () => {
      view.unmount();
    });
  });
});
