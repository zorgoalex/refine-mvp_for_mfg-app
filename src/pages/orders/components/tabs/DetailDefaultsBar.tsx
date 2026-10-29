// «NewLine», mockup 05: «Параметры деталей по умолчанию» — one row above the details table.
import React from 'react';
import { Button, InputNumber, Select } from 'antd';
import { useSelect } from '../../../../query/orderLifecycleQueries';
import { createBackendSelectProps, useOrderFormData } from '../../../../hooks/useOrderFormData';
import { filterCuttableOptions, toSheetSelectOptions, useSheetMaterialOptions } from '../../../../hooks/useSheetMaterialOptions';
import { numberFormatter, numberParser } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { changedDetailDefaults, INITIAL_DETAIL_DEFAULTS, type DetailDefaults } from '../../detailDefaults';

interface DetailDefaultsBarProps {
  value: DetailDefaults;
  onChange: (next: DetailDefaults) => void;
  /** the material the next new row gets by the material rule (shown as the placeholder) */
  ruleMaterialId?: number;
}

export const DetailDefaultsBar: React.FC<DetailDefaultsBarProps> = ({ value, onChange, ruleMaterialId }) => {
  const orderFormData = useOrderFormData();
  const backend = orderFormData.enabled;
  const sheetMaterials = useSheetMaterialOptions();

  const { selectProps: millingSelect } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'milling_type_id', order: 'asc' }],
    defaultValue: value.millingTypeId,
    queryOptions: { enabled: !backend },
  });
  const { selectProps: edgeSelect } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'edge_type_id', order: 'asc' }],
    defaultValue: value.edgeTypeId,
    queryOptions: { enabled: !backend },
  });
  const { selectProps: filmSelect } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 100 },
    ...(value.filmId ? { defaultValue: value.filmId } : {}),
    queryOptions: { enabled: !backend },
  });
  const millingProps = backend ? createBackendSelectProps(orderFormData.references.millingTypes, orderFormData.isLoading) : millingSelect;
  const edgeProps = backend ? createBackendSelectProps(orderFormData.references.edgeTypes, orderFormData.isLoading) : edgeSelect;
  const filmProps = backend ? createBackendSelectProps(orderFormData.references.films, orderFormData.isLoading) : filmSelect;

  const ruleMaterialLabel = ruleMaterialId != null ? sheetMaterials.byId.get(ruleMaterialId)?.label : undefined;
  const set = (patch: Partial<DetailDefaults>) => onChange({ ...value, ...patch });
  const changed = changedDetailDefaults(value);

  return (
    <section className="wb-detail-defaults" aria-labelledby="wb-detail-defaults-title">
      <div className="wb-detail-defaults__head">
        <h3 id="wb-detail-defaults-title">Параметры деталей по умолчанию</h3>
        <span>подставляются в новые строки — в каждой строке можно изменить</span>
        {changed > 0 ? (
          <Button size="small" type="link" onClick={() => onChange(INITIAL_DETAIL_DEFAULTS)}>Как обычно</Button>
        ) : null}
      </div>
      <div className="wb-detail-defaults__fields">
        <label className="wb-detail-defaults__field wb-detail-defaults__field--wide">
          <span>Материал</span>
          <Select
            aria-label="Материал по умолчанию"
            value={value.sheetMaterialTypeId ?? undefined}
            options={toSheetSelectOptions(filterCuttableOptions(sheetMaterials.options), value.sheetMaterialTypeId ?? undefined)}
            loading={sheetMaterials.isLoading}
            placeholder={ruleMaterialLabel ? `как в предыдущей строке (${ruleMaterialLabel})` : 'как в предыдущей строке'}
            allowClear
            showSearch
            optionFilterProp="label"
            onChange={(next) => set({ sheetMaterialTypeId: typeof next === 'number' ? next : null })}
          />
        </label>
        <label className="wb-detail-defaults__field wb-detail-defaults__field--wide">
          <span>Плёнка</span>
          <Select
            {...filmProps}
            aria-label="Плёнка по умолчанию"
            value={value.filmId ?? undefined}
            placeholder="без плёнки"
            allowClear
            showSearch
            onChange={(next) => set({ filmId: typeof next === 'number' ? next : null })}
          />
        </label>
        <label className="wb-detail-defaults__field">
          <span>Фрезеровка</span>
          <Select
            {...millingProps}
            aria-label="Фрезеровка по умолчанию"
            value={value.millingTypeId}
            showSearch
            onChange={(next) => set({ millingTypeId: Number(next) || INITIAL_DETAIL_DEFAULTS.millingTypeId })}
          />
        </label>
        <label className="wb-detail-defaults__field">
          <span>Обкат</span>
          <Select
            {...edgeProps}
            aria-label="Обкат по умолчанию"
            value={value.edgeTypeId}
            showSearch
            onChange={(next) => set({ edgeTypeId: Number(next) || INITIAL_DETAIL_DEFAULTS.edgeTypeId })}
          />
        </label>
        <label className="wb-detail-defaults__field">
          <span>Цена за м², {CURRENCY_SYMBOL}</span>
          <InputNumber
            aria-label="Цена за м² по умолчанию"
            value={value.pricePerSqm ?? undefined}
            min={0}
            precision={2}
            formatter={(next) => numberFormatter(next === undefined ? undefined : Number(next), 2)}
            parser={numberParser}
            placeholder="не задана"
            style={{ width: '100%' }}
            onChange={(next) => set({ pricePerSqm: typeof next === 'number' && next > 0 ? next : null })}
          />
        </label>
      </div>
    </section>
  );
};
