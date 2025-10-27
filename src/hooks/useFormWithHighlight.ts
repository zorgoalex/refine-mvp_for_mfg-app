import { useForm as useRefineForm, UseFormProps, UseFormReturnType } from "@refinedev/antd";
import { useNavigate } from "react-router-dom";
import { BaseRecord, HttpError } from "@refinedev/core";

/**
 * Extended useForm hook that adds automatic navigation with highlight support
 * Usage in create.tsx:
 * const { formProps, saveButtonProps } = useFormWithHighlight({ resource: "vendors", idField: "vendor_id" });
 *
 * Usage in edit.tsx:
 * const { formProps, saveButtonProps } = useFormWithHighlight({ resource: "vendors", idField: "vendor_id", action: "edit" });
 */
export const useFormWithHighlight = <
  TQueryFnData extends BaseRecord = BaseRecord,
  TError extends HttpError = HttpError,
  TVariables = {},
  TData extends BaseRecord = TQueryFnData,
  TResponse extends BaseRecord = TData,
  TResponseError extends HttpError = TError
>(props: {
  resource: string;
  idField: string;
  action?: "create" | "edit";
  formProps?: UseFormProps<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError>;
}): UseFormReturnType<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError> => {
  const navigate = useNavigate();
  const { resource, idField, action = "create", formProps: additionalProps } = props;

  const formReturn = useRefineForm<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError>({
    redirect: false,
    ...additionalProps,
    onMutationSuccess: (data, variables, context, isAutoSave) => {
      // Call original onMutationSuccess if provided
      additionalProps?.onMutationSuccess?.(data, variables, context, isAutoSave);

      // Navigate with highlight parameter
      const recordId = data.data?.[idField];
      if (recordId) {
        navigate(`/${resource}?highlightId=${recordId}`, { replace: true });
      }
    },
  });

  return formReturn;
};
