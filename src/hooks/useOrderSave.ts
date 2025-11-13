// Hook for saving order with MVP strategy
// Uses sequential requests with rollback on error

import { useState } from 'react';
import { useDataProvider, useInvalidate } from '@refinedev/core';
import { notification, Modal } from 'antd';
import { OrderFormValues } from '../types/orders';
import { useOrderFormStore } from '../stores/orderFormStore';

interface UseOrderSaveResult {
  saveOrder: (values: OrderFormValues, isEdit: boolean) => Promise<number | null>;
  isSaving: boolean;
  error: Error | null;
}

/**
 * Hook for saving order form data
 * MVP Strategy: Sequential requests with rollback on error
 */
export const useOrderSave = (): UseOrderSaveResult => {
  const dataProvider = useDataProvider();
  const invalidate = useInvalidate();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  /**
   * Parse error message from various error formats
   */
  const parseErrorMessage = (error: any): string => {
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    if (error?.errors?.[0]?.message) return error.errors[0].message;
    return 'Неизвестная ошибка при сохранении';
  };

  /**
   * Save order with MVP strategy
   */
  const saveOrder = async (
    values: OrderFormValues,
    isEdit: boolean
  ): Promise<number | null> => {
    let createdOrderId: number | null = null;
    setIsSaving(true);
    setError(null);

    try {
      // ========== STEP 1: Save/Update orders (header) ==========
      if (isEdit && values.header.order_id) {
        // Update existing order
        const headerData = {
          ...values.header,
          // Convert Date objects to strings
          order_date: typeof values.header.order_date === 'string'
            ? values.header.order_date
            : values.header.order_date?.toISOString?.().split('T')[0],
          planned_completion_date: values.header.planned_completion_date
            ? (typeof values.header.planned_completion_date === 'string'
              ? values.header.planned_completion_date
              : values.header.planned_completion_date?.toISOString?.().split('T')[0])
            : null,
          completion_date: values.header.completion_date
            ? (typeof values.header.completion_date === 'string'
              ? values.header.completion_date
              : values.header.completion_date?.toISOString?.().split('T')[0])
            : null,
          issue_date: values.header.issue_date
            ? (typeof values.header.issue_date === 'string'
              ? values.header.issue_date
              : values.header.issue_date?.toISOString?.().split('T')[0])
            : null,
          payment_date: values.header.payment_date
            ? (typeof values.header.payment_date === 'string'
              ? values.header.payment_date
              : values.header.payment_date?.toISOString?.().split('T')[0])
            : null,
          // Convert empty strings to null for file links
          link_cutting_file: values.header.link_cutting_file || null,
          link_cutting_image_file: values.header.link_cutting_image_file || null,
          link_cad_file: values.header.link_cad_file || null,
          link_pdf_file: values.header.link_pdf_file || null,
          // Convert empty strings to null for ref_key_1c
          ref_key_1c: values.header.ref_key_1c || null,
          version: values.version, // For optimistic locking
        };

        const orderResult = await dataProvider().update({
          resource: 'orders',
          id: values.header.order_id,
          variables: headerData,
        });
        createdOrderId = orderResult.data.order_id;

        // NOTE: Proper optimistic locking should be implemented server-side
        // by updating with a WHERE clause on current version and checking affected_rows.
        // The previous check caused false conflicts when version did not increment on backend.
        // Keep result as-is; surface conflict handling once server-side lock is available.
      } else {
        // Create new order
        const headerData = {
          ...values.header,
          // Convert Date objects to strings
          order_date: typeof values.header.order_date === 'string'
            ? values.header.order_date
            : values.header.order_date?.toISOString?.().split('T')[0],
          planned_completion_date: values.header.planned_completion_date
            ? (typeof values.header.planned_completion_date === 'string'
              ? values.header.planned_completion_date
              : values.header.planned_completion_date?.toISOString?.().split('T')[0])
            : null,
          completion_date: values.header.completion_date
            ? (typeof values.header.completion_date === 'string'
              ? values.header.completion_date
              : values.header.completion_date?.toISOString?.().split('T')[0])
            : null,
          issue_date: values.header.issue_date
            ? (typeof values.header.issue_date === 'string'
              ? values.header.issue_date
              : values.header.issue_date?.toISOString?.().split('T')[0])
            : null,
          payment_date: values.header.payment_date
            ? (typeof values.header.payment_date === 'string'
              ? values.header.payment_date
              : values.header.payment_date?.toISOString?.().split('T')[0])
            : null,
          // Convert empty strings to null for file links
          link_cutting_file: values.header.link_cutting_file === '' ? null : values.header.link_cutting_file,
          link_cutting_image_file: values.header.link_cutting_image_file === '' ? null : values.header.link_cutting_image_file,
          link_cad_file: values.header.link_cad_file === '' ? null : values.header.link_cad_file,
          link_pdf_file: values.header.link_pdf_file === '' ? null : values.header.link_pdf_file,
          // Convert empty strings to null for ref_key_1c
          ref_key_1c: values.header.ref_key_1c === '' ? null : values.header.ref_key_1c,
        };

        console.log('[useOrderSave] Creating order with data:', headerData);

        const orderResult = await dataProvider().create({
          resource: 'orders',
          variables: {
            ...headerData,
            created_by: values.header?.created_by ?? 1,
          },
        });

        console.log('[useOrderSave] Order created successfully:', orderResult.data);
        createdOrderId = orderResult.data.order_id;
      }

      // ========== STEP 2: Save order_details ==========
      if (values.details && values.details.length > 0) {
        const { originalDetails } = useOrderFormStore.getState();
        const normalizeDetail = (d: any) => {
          const { detail_id, order_id, temp_id, created_at, updated_at, created_by, edited_by, version, ...rest } = d || {};
          return rest;
        };
        const detailPromises = values.details.map((detail) => {
          if (detail.detail_id) {
            // Update only if changed
            const original = originalDetails[detail.detail_id];
            // Exclude detail_id, temp_id from variables for update
            const { detail_id, temp_id, ...detailData } = detail;
            const updateData = {
              ...detailData,
              order_id: createdOrderId,
            };

            const normalizedOriginal = normalizeDetail(original);
            const normalizedUpdate = normalizeDetail(updateData);
            const isUnchanged = original && JSON.stringify(normalizedOriginal) === JSON.stringify(normalizedUpdate);

            if (isUnchanged) {
              return Promise.resolve(null);
            }
            return dataProvider().update({
              resource: 'order_details',
              id: detail.detail_id,
              variables: updateData,
            });
          } else {
            // Create new detail - exclude temp_id, detail_id and all audit/system fields
            const { temp_id, detail_id, created_at, updated_at, created_by, edited_by, version, ...detailData } = detail;
            // console.log('[useOrderSave] CREATE detail - original:', detail);
            // console.log('[useOrderSave] CREATE detail - excluded fields:', { temp_id, detail_id, created_at, updated_at, created_by, edited_by, version });
            // console.log('[useOrderSave] CREATE detail - cleaned data:', detailData);
            const createVariables = {
              ...detailData,
              order_id: createdOrderId,
              created_by: 1, // Always set created_by=1 for new records in dev mode
            };
            // console.log('[useOrderSave] CREATE detail - final variables:', createVariables);
            return dataProvider().create({
              resource: 'order_details',
              variables: createVariables,
            });
          }
        });

        await Promise.all(detailPromises);
      }

      // ========== STEP 3: Delete removed details ==========
      if (values.deletedDetails && values.deletedDetails.length > 0) {
        const deleteDetailPromises = values.deletedDetails.map((detailId) =>
          dataProvider().deleteOne({
            resource: 'order_details',
            id: detailId,
          })
        );
        await Promise.all(deleteDetailPromises);
      }

      // ========== STEP 3.5: Recalculate and update total_amount ==========
      // Fetch saved details from DB to get accurate data (including any DB-calculated fields)
      console.log('[useOrderSave] Fetching saved details from DB for order:', createdOrderId);

      const savedDetailsResult = await dataProvider().getList({
        resource: 'order_details',
        filters: [{ field: 'order_id', operator: 'eq', value: createdOrderId }],
        pagination: { current: 1, pageSize: 1000 },
      });

      const savedDetails = savedDetailsResult.data || [];
      console.log('[useOrderSave] Fetched', savedDetails.length, 'details from DB');

      if (savedDetails.length > 0) {
        console.log('[useOrderSave] Recalculating total_amount from saved details...');

        // Calculate total_amount by summing detail_cost from all SAVED details
        const totalAmount = savedDetails.reduce((sum, detail: any) => {
          const cost = detail.detail_cost || 0;
          console.log('[useOrderSave] Detail #' + detail.detail_number + ' cost:', cost);
          return sum + cost;
        }, 0);

        console.log('[useOrderSave] Calculated total_amount:', totalAmount);

        // Update order with calculated total_amount
        await dataProvider().update({
          resource: 'orders',
          id: createdOrderId,
          variables: {
            total_amount: totalAmount,
          },
        });

        console.log('[useOrderSave] Order total_amount updated successfully');
      } else {
        console.log('[useOrderSave] No details found, setting total_amount to 0');
        await dataProvider().update({
          resource: 'orders',
          id: createdOrderId,
          variables: {
            total_amount: 0,
          },
        });
      }

      // ========== STEP 4: Save payments ==========
      if (values.payments && values.payments.length > 0) {
        const { originalPayments } = useOrderFormStore.getState();
        const normalizePayment = (p: any) => {
          const { payment_id, order_id, temp_id, created_at, updated_at, created_by, edited_by, ...rest } = p || {};
          return rest;
        };
        const paymentPromises = values.payments.map((payment) => {
          if (payment.payment_id) {
            // Update only if changed
            const original = originalPayments[payment.payment_id];
            // Exclude payment_id, temp_id from variables for update
            const { payment_id, temp_id, ...paymentData } = payment;
            const updateData = {
              ...paymentData,
              order_id: createdOrderId,
            };
            if (original && JSON.stringify(normalizePayment(original)) === JSON.stringify(normalizePayment(updateData))) {
              return Promise.resolve(null);
            }
            return dataProvider().update({
              resource: 'payments',
              id: payment.payment_id,
              variables: updateData,
            });
          } else {
            // Create new payment - exclude temp_id, payment_id and all audit/system fields
            const { temp_id, payment_id, created_at, updated_at, created_by, edited_by, ...paymentData } = payment;
            return dataProvider().create({
              resource: 'payments',
              variables: {
                ...paymentData,
                order_id: createdOrderId,
                created_by: 1, // Always set created_by=1 for new records in dev mode
              },
            });
          }
        });

        await Promise.all(paymentPromises);
      }

      // ========== STEP 5: Delete removed payments ==========
      if (values.deletedPayments && values.deletedPayments.length > 0) {
        const deletePaymentPromises = values.deletedPayments.map((paymentId) =>
          dataProvider().deleteOne({
            resource: 'payments',
            id: paymentId,
          })
        );
        await Promise.all(deletePaymentPromises);
      }

      // ========== STEP 6: Save workshops ==========
      if (values.workshops && values.workshops.length > 0) {
        const workshopPromises = values.workshops.map((workshop) => {
          if (workshop.order_workshop_id) {
            // Update existing workshop - exclude order_workshop_id, temp_id from variables
            const { order_workshop_id, temp_id, ...workshopData } = workshop;
            return dataProvider().update({
              resource: 'order_workshops',
              id: workshop.order_workshop_id,
              variables: {
                ...workshopData,
                order_id: createdOrderId,
              },
            });
          } else {
            // Create new workshop - exclude temp_id, order_workshop_id and all audit/system fields
            const { temp_id, order_workshop_id, created_at, updated_at, created_by, edited_by, ...workshopData } = workshop;
            return dataProvider().create({
              resource: 'order_workshops',
              variables: {
                ...workshopData,
                order_id: createdOrderId,
                created_by: 1, // Always set created_by=1 for new records in dev mode
              },
            });
          }
        });

        await Promise.all(workshopPromises);
      }

      // ========== STEP 7: Delete removed workshops ==========
      if (values.deletedWorkshops && values.deletedWorkshops.length > 0) {
        const deleteWorkshopPromises = values.deletedWorkshops.map((workshopId) =>
          dataProvider().deleteOne({
            resource: 'order_workshops',
            id: workshopId,
          })
        );
        await Promise.all(deleteWorkshopPromises);
      }

      // ========== STEP 8: Save requirements ==========
      if (values.requirements && values.requirements.length > 0) {
        const requirementPromises = values.requirements.map((requirement) => {
          if (requirement.requirement_id) {
            // Update existing requirement - exclude requirement_id, temp_id from variables
            const { requirement_id, temp_id, ...requirementData } = requirement;
            return dataProvider().update({
              resource: 'order_resource_requirements',
              id: requirement.requirement_id,
              variables: {
                ...requirementData,
                order_id: createdOrderId,
              },
            });
          } else {
            // Create new requirement - exclude temp_id, requirement_id and all audit/system fields
            const { temp_id, requirement_id, created_at, updated_at, created_by, edited_by, ...requirementData } = requirement;
            return dataProvider().create({
              resource: 'order_resource_requirements',
              variables: {
                ...requirementData,
                order_id: createdOrderId,
                created_by: 1, // Always set created_by=1 for new records in dev mode
              },
            });
          }
        });

        await Promise.all(requirementPromises);
      }

      // ========== STEP 9: Delete removed requirements ==========
      if (values.deletedRequirements && values.deletedRequirements.length > 0) {
        const deleteRequirementPromises = values.deletedRequirements.map((requirementId) =>
          dataProvider().deleteOne({
            resource: 'order_resource_requirements',
            id: requirementId,
          })
        );
        await Promise.all(deleteRequirementPromises);
      }

      // ========== STEP 10: Invalidate queries ==========
      await invalidate({
        resource: 'orders',
        invalidates: ['list', 'detail'],
        id: createdOrderId,
      });

      await invalidate({
        resource: 'orders_view',
        invalidates: ['list', 'detail'],
        id: createdOrderId,
      });

      // Ensure child lists are refreshed for the current order
      await invalidate({ resource: 'order_details', invalidates: ['list'] });
      await invalidate({ resource: 'payments', invalidates: ['list'] });

      // ========== SUCCESS ==========
      notification.success({
        message: `Заказ успешно ${isEdit ? 'обновлен' : 'создан'}`,
        description: `ID заказа: ${createdOrderId}`,
      });

      setIsSaving(false);
      // Sync originals in store to current state to avoid redundant updates on next save
      try {
        useOrderFormStore.getState().syncOriginals();
      } catch {}
      return createdOrderId;
    } catch (err: any) {
      // Handle error silently in UI notifications
      console.error('[useOrderSave] Error saving order:', err);
      console.error('[useOrderSave] Error details:', JSON.stringify(err, null, 2));
      setError(err);

      // ========== ROLLBACK: Delete created order if this was a create operation ==========
      if (createdOrderId && !isEdit) {
        try {
          await dataProvider().deleteOne({
            resource: 'orders',
            id: createdOrderId,
          });
          // rollback succeeded
        } catch (rollbackError) {
          // ignore rollback errors in console
        }
      }

      // ========== HANDLE VERSION CONFLICT ==========
      if (err.message === 'VERSION_CONFLICT') {
        Modal.error({
          title: 'Конфликт версий',
          content:
            'Заказ был изменен другим пользователем. Обновите страницу и повторите изменения.',
          okText: 'Обновить страницу',
          onOk: () => window.location.reload(),
        });
        setIsSaving(false);
        return null;
      }

      // ========== SHOW ERROR MESSAGE ==========
      const errorMessage = parseErrorMessage(err);
      notification.error({
        message: `Ошибка ${isEdit ? 'обновления' : 'создания'} заказа`,
        description: errorMessage,
        duration: 0, // Don't auto-hide
      });

      setIsSaving(false);
      return null;
    }
  };

  return {
    saveOrder,
    isSaving,
    error,
  };
};
