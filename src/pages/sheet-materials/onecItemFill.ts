import type { OnecItemOption } from '../../api/sheetMaterialsApi';

/** Что подставить в пустые «Тип номенклатуры» и «Категория номенклатуры» из выбранной позиции 1С (заполненное не трогается). */
export function nomenclatureFromOnec(
  current: { nomenclatureType?: string | null; nomenclatureCategory?: string | null },
  item: Pick<OnecItemOption, 'nomenclatureType' | 'categoryName'>,
): { nomenclatureType?: string; nomenclatureCategory?: string } {
  const patch: { nomenclatureType?: string; nomenclatureCategory?: string } = {};
  if (!current.nomenclatureType?.trim() && item.nomenclatureType) patch.nomenclatureType = item.nomenclatureType.slice(0, 50);
  if (!current.nomenclatureCategory?.trim() && item.categoryName && item.categoryName !== '<Без категории>') patch.nomenclatureCategory = item.categoryName.slice(0, 150);
  return patch;
}

/** Заполняет пустые поля номенклатуры формы из выбранной позиции 1С. */
export function fillNomenclatureFromOnec(
  form: { getFieldsValue: (names: string[]) => Record<string, unknown>; setFieldsValue: (values: Record<string, unknown>) => void },
  item: OnecItemOption,
): void {
  const patch = nomenclatureFromOnec(form.getFieldsValue(['nomenclatureType', 'nomenclatureCategory']) as Parameters<typeof nomenclatureFromOnec>[0], item);
  if (Object.keys(patch).length > 0) form.setFieldsValue(patch);
}
