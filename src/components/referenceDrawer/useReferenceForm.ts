// useForm страницы справочника: на своей странице — как раньше (запись и действие из адреса), в боковой панели
// NewLine — из контекста панели, без перехода после сохранения; сохранено — панель закрывается.
import { useForm, type UseFormProps, type UseFormReturnType } from '@refinedev/antd';
import type { BaseRecord, HttpError } from '@refinedev/core';
import { useReferenceDrawerForm } from './ReferenceDrawerContext';

export const useReferenceForm = <
  TQueryFnData extends BaseRecord = BaseRecord,
  TError extends HttpError = HttpError,
  TVariables = {},
>(props: UseFormProps<TQueryFnData, TError, TVariables> = {}): UseFormReturnType<TQueryFnData, TError, TVariables> => {
  const drawer = useReferenceDrawerForm();
  return useForm<TQueryFnData, TError, TVariables>(drawer ? {
    ...props,
    resource: drawer.resource,
    action: drawer.action,
    id: drawer.action === 'edit' ? drawer.id : undefined,
    redirect: false,
    onMutationSuccess: (...args) => {
      props.onMutationSuccess?.(...args);
      drawer.onSaved();
    },
  } : props);
};
