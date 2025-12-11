import { useForm as useRefineForm, UseFormProps, UseFormReturnType } from "@refinedev/antd";
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
  const { resource, idField, action = "create", formProps: additionalProps } = props;

  const formReturn = useRefineForm<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError>({
    ...additionalProps,
    redirect: false,
    onMutationSuccess: (data, variables, context, isAutoSave) => {
      // Call original onMutationSuccess if provided
      additionalProps?.onMutationSuccess?.(data, variables, context, isAutoSave);

      // Navigate manually with highlightId
      const recordId = data.data?.[idField];
      if (recordId) {
        const baseUrl = `${window.location.origin}/${resource}`;
        if (action === "edit") {
          // After edit: navigate to show page
          window.location.href = `${baseUrl}/show/${recordId}`;
        } else {
          // After create: navigate to list page with highlight parameter
          window.location.href = `${baseUrl}?highlightId=${recordId}`;
        }
      }
    },
  });

  return formReturn;
};
