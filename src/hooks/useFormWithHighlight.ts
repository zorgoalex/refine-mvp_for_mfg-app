import { useForm as useRefineForm, UseFormProps, UseFormReturnType } from "@refinedev/antd";
import { BaseRecord, HttpError, useGo } from "@refinedev/core";
import { RESOURCE_LABELS } from "../utils/tabLabels";
import { useRecordTabTitle } from "../utils/recordTitle";

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
  successResource?: string;
  navigateOnSuccess?: boolean;
  formProps?: UseFormProps<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError>;
}): UseFormReturnType<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError> => {
  const {
    resource,
    idField,
    action = "create",
    successResource = resource,
    navigateOnSuccess = true,
    formProps: additionalProps,
  } = props;
  const go = useGo();

  const formReturn = useRefineForm<TQueryFnData, TError, TVariables, TData, TResponse, TResponseError>({
    ...additionalProps,
    resource,
    redirect: false,
    onMutationSuccess: (data, variables, context, isAutoSave) => {
      // Call original onMutationSuccess if provided
      additionalProps?.onMutationSuccess?.(data, variables, context, isAutoSave);

      if (!navigateOnSuccess) {
        return;
      }

      // Navigate manually with highlightId
      const recordId = data.data?.[idField];
      if (recordId) {
        if (action === "edit") {
          // After edit: navigate to show page
          go({
            to: { resource: successResource, action: "show", id: recordId },
            type: "replace",
          });
        } else {
          // After create: navigate to list page with highlight parameter
          go({
            to: { resource: successResource, action: "list" },
            query: { highlightId: recordId },
            type: "replace",
          });
        }
      }
    },
  });

  useRecordTabTitle({
    resourceLabel: RESOURCE_LABELS[resource] ?? resource,
    actionLabel: "Редактирование",
    record: formReturn.queryResult?.data?.data,
    fallbackId: formReturn.id,
    enabled: action === "edit",
  });

  return formReturn;
};
