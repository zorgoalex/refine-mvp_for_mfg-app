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
        // Exclude audit fields (auto-managed by Hasura permissions)
        // Exclude doweling fields (managed via order_doweling_links table)
        // Exclude VIEW-only fields (design_engineer, design_engineer_id come from doweling_orders, not orders table)
        const { created_by, edited_by, created_at, updated_at, order_id, doweling_order_id, doweling_order_name, doweling_links, design_engineer, design_engineer_id, ...restHeader } = values.header;

        const headerData = {
          ...restHeader,
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
          // Ensure discount and surcharge are numbers (not null/undefined)
          discount: values.header.discount || 0,
          surcharge: values.header.surcharge || 0,
          version: values.version, // For optimistic locking
        };

        console.log('[useOrderSave] Updating order with data:', headerData);
        console.log('[useOrderSave] Financial fields - total_amount:', headerData.total_amount,
          'discount:', headerData.discount,
          'surcharge:', headerData.surcharge,
          'final_amount:', headerData.final_amount);

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
        // Exclude audit fields (will be set by Hasura or explicitly below)
        // Exclude doweling fields (managed via order_doweling_links table)
        // Exclude VIEW-only fields (design_engineer, design_engineer_id come from doweling_orders, not orders table)
        const { created_by, edited_by, created_at, updated_at, order_id, doweling_order_id, doweling_order_name, doweling_links, design_engineer, design_engineer_id, ...restHeader } = values.header;

        const headerData = {
          ...restHeader,
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
          // Ensure discount and surcharge are numbers (not null/undefined)
          discount: values.header.discount || 0,
          surcharge: values.header.surcharge || 0,
        };

        console.log('[useOrderSave] Creating order with data:', headerData);
        console.log('[useOrderSave] Financial fields - total_amount:', headerData.total_amount,
          'discount:', headerData.discount,
          'surcharge:', headerData.surcharge,
          'final_amount:', headerData.final_amount);

        const orderResult = await dataProvider().create({
          resource: 'orders',
          variables: headerData,
        });

        console.log('[useOrderSave] Order created successfully:', orderResult.data);
        createdOrderId = orderResult.data.order_id;
      }

      // ========== STEP 2: Save order_details ==========
      // Filter out unfilled details (new details with only default values)
      const isDetailUnfilled = (detail: any): boolean => {
        // Only check new details (no detail_id)
        if (detail.detail_id) return false;

        // Check if essential fields are empty/null/zero
        const hasNoHeight = !detail.height || detail.height === 0;
        const hasNoWidth = !detail.width || detail.width === 0;
        const hasNoArea = !detail.area || detail.area === 0;

        // If height, width, and area are all empty - consider unfilled
        return hasNoHeight && hasNoWidth && hasNoArea;
      };

      // Filter details to exclude unfilled ones
      const filledDetails = (values.details || []).filter(detail => !isDetailUnfilled(detail));
      const skippedCount = (values.details?.length || 0) - filledDetails.length;
      if (skippedCount > 0) {
        console.log(`[useOrderSave] Skipped ${skippedCount} unfilled detail(s)`);
      }

      // ========== NORMALIZE DETAIL NUMBERS ==========
      // Sort by current detail_number and renumber sequentially 1, 2, 3...
      // This fixes any duplicates or gaps in numbering
      const sortedDetails = [...filledDetails].sort((a, b) =>
        (a.detail_number || 0) - (b.detail_number || 0)
      );
      const normalizedDetails = sortedDetails.map((detail, index) => ({
        ...detail,
        detail_number: index + 1,
      }));
      console.log(`[useOrderSave] Normalized ${normalizedDetails.length} detail numbers`);

      if (normalizedDetails.length > 0) {
        const { originalDetails } = useOrderFormStore.getState();
        const normalizeDetail = (d: any) => {
          const {
            detail_id,
            order_id,
            temp_id,
            created_at,
            updated_at,
            created_by,
            edited_by,
            version,
            __typename,
            ...rest
          } = d || {};
          return rest;
        };
        const buildDetailPayload = (detail: any) => ({
          ...normalizeDetail(detail),
          order_id: createdOrderId,
        });
        const detailPromises = normalizedDetails.map((detail) => {
          if (detail.detail_id) {
            // Update only if changed
            const original = originalDetails[detail.detail_id];
            const updateData = buildDetailPayload(detail);

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
            // console.log('[useOrderSave] CREATE detail - original:', detail);
            // console.log('[useOrderSave] CREATE detail - excluded fields:', { temp_id, detail_id, created_at, updated_at, created_by, edited_by, version });
            // console.log('[useOrderSave] CREATE detail - cleaned data:', detailData);
            const createVariables = buildDetailPayload(detail);
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
        console.log('[useOrderSave] Recalculating totals from saved details...');

        // Calculate total_amount by summing detail_cost from all SAVED details
        const totalAmount = savedDetails.reduce((sum, detail: any) => {
          const cost = detail.detail_cost || 0;
          console.log('[useOrderSave] Detail #' + detail.detail_number + ' cost:', cost);
          return sum + cost;
        }, 0);

        // Calculate total_area by summing area from all details
        const totalArea = savedDetails.reduce((sum, detail: any) => {
          return sum + (detail.area || 0);
        }, 0);

        // Calculate parts_count by summing quantity from all details
        const partsCount = savedDetails.reduce((sum, detail: any) => {
          return sum + (detail.quantity || 0);
        }, 0);

        // Calculate final_amount: total_amount - discount + surcharge
        const discount = values.header.discount || 0;
        const surcharge = values.header.surcharge || 0;
        const finalAmount = totalAmount - discount + surcharge;

        console.log('[useOrderSave] Calculated totals - total_amount:', totalAmount, ', total_area:', totalArea, ', parts_count:', partsCount, ', final_amount:', finalAmount);

        // Update order with calculated totals
        await dataProvider().update({
          resource: 'orders',
          id: createdOrderId,
          variables: {
            total_amount: totalAmount,
            total_area: totalArea,
            parts_count: partsCount,
            final_amount: finalAmount,
          },
        });

        console.log('[useOrderSave] Order totals updated successfully');
      } else {
        console.log('[useOrderSave] No details found, setting totals to 0');
        // Calculate final_amount even with 0 total: 0 - discount + surcharge
        const discount = values.header.discount || 0;
        const surcharge = values.header.surcharge || 0;
        const finalAmount = 0 - discount + surcharge;

        await dataProvider().update({
          resource: 'orders',
          id: createdOrderId,
          variables: {
            total_amount: 0,
            total_area: 0,
            parts_count: 0,
            final_amount: finalAmount,
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
            // Exclude payment_id, temp_id and audit fields from variables for update
            const { payment_id, temp_id, created_at, updated_at, created_by, edited_by, ...paymentData } = payment;
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
            // Update existing workshop - exclude order_workshop_id, temp_id and audit fields from variables
            const { order_workshop_id, temp_id, created_at, updated_at, created_by, edited_by, ...workshopData } = workshop;
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
            // Update existing requirement - exclude requirement_id, temp_id and audit fields from variables
            const { requirement_id, temp_id, created_at, updated_at, created_by, edited_by, ...requirementData } = requirement;
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

      // ========== STEP 10: Delete removed doweling links ==========
      if (values.deletedDowelingLinks && values.deletedDowelingLinks.length > 0) {
        const deleteDowelingLinkPromises = values.deletedDowelingLinks.map((linkId) =>
          dataProvider().deleteOne({
            resource: 'order_doweling_links',
            id: linkId,
          })
        );
        await Promise.all(deleteDowelingLinkPromises);
      }

      // ========== STEP 10.1: Create new order_doweling_links ==========
      if (values.dowelingLinks && values.dowelingLinks.length > 0) {
        const newLinks = values.dowelingLinks.filter((link) => !link.order_doweling_link_id);
        if (newLinks.length > 0) {
          const createLinkPromises = newLinks.map((link) =>
            dataProvider().create({
              resource: 'order_doweling_links',
              variables: {
                order_id: createdOrderId,
                doweling_order_id: link.doweling_order_id,
                delete_flag: false,
                version: 0,
              },
            })
          );
          await Promise.all(createLinkPromises);
        }
      }

      // ========== STEP 10.2: Update doweling_orders (design_engineer_id) ==========
      if (values.dowelingLinks && values.dowelingLinks.length > 0) {
        const updateDowelingOrderPromises = values.dowelingLinks
          .filter((link) => link.doweling_order?.doweling_order_id && link.doweling_order?.design_engineer_id !== undefined)
          .map((link) =>
            dataProvider().update({
              resource: 'doweling_orders',
              id: link.doweling_order!.doweling_order_id,
              variables: {
                design_engineer_id: link.doweling_order!.design_engineer_id,
              },
            })
          );
        await Promise.all(updateDowelingOrderPromises);
      }

      // ========== STEP 11: Invalidate queries ==========
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
      await invalidate({ resource: 'order_doweling_links', invalidates: ['list'] });
      await invalidate({ resource: 'doweling_orders', invalidates: ['list'] });
      await invalidate({ resource: 'doweling_orders_view', invalidates: ['list'] });

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
