import { useSelect } from '../../ui/refineSelect';
import { Select } from 'antd';

interface SuppliersSelectProps {
  /** id поставщиков по порядку: первый — основной. */
  value?: number[];
  onChange?: (value: number[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Упорядоченный выбор поставщиков из справочника «Поставщики»: порядок выбора = порядок в списке, первый — основной.
 * Поиск по названию — на сервере (Hasura select, как у других полей поставщика).
 */
export const SuppliersSelect: React.FC<SuppliersSelectProps> = ({ value, onChange, disabled, placeholder }) => {
  const { selectProps } = useSelect({
    resource: 'suppliers',
    optionLabel: 'supplier_name',
    optionValue: 'supplier_id',
    defaultValue: value ?? [],
  });
  return (
    <Select
      {...selectProps}
      mode="multiple"
      allowClear
      disabled={disabled}
      placeholder={placeholder ?? 'Выберите поставщиков (первый — основной)'}
      value={value ?? []}
      onChange={(next) => onChange?.((next as unknown[]).map(Number))}
    />
  );
};
