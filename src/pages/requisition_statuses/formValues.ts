/** Form state includes unset inputs and cleared nullable fields. */
export interface RequisitionStatusFormValues {
  requisition_status_name?: string | null;
  sort_order?: number | null;
  is_active?: boolean;
  description?: string | null;
}
