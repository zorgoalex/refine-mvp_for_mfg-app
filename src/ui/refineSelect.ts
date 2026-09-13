import { useSelect as nativeUseSelect } from '@refinedev/antd';
import type { UseSelectReturnType } from '@refinedev/antd';
import type { BaseRecord, HttpError } from '@refinedev/core';

// Installed Refine returns these props, not controlled value/defaultValue/onChange.
// Keep native arguments and both query results; export the same runtime function.
type ActualSelectProps = Pick<UseSelectReturnType['selectProps'],
  'options' | 'onSearch' | 'loading' | 'showSearch' | 'filterOption'>;

type CompatibleUseSelect = <
  TData extends BaseRecord = BaseRecord,
  TError extends HttpError = HttpError,
>(
  props: Parameters<typeof nativeUseSelect<TData, TError>>[0],
) => Omit<UseSelectReturnType<TData>, 'selectProps'> & { selectProps: ActualSelectProps };

export const useSelect: CompatibleUseSelect = nativeUseSelect;
