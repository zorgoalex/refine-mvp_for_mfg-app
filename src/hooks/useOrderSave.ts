// Hook for saving order with MVP strategy
// Uses sequential requests with rollback on error

import { useState } from 'react';
import { useDataProvider, useInvalidate } from '@refinedev/core';
import { notification, Modal } from 'antd';
import { OrderFormValues } from '../types/orders';

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
        const orderResult = await dataProvider().update({
          resource: 'orders',
          id: values.header.order_id,
          variables: {
            ...values.header,
            version: values.version, // For optimistic locking
          },
        });
        createdOrderId = orderResult.data.order_id;

        // Check if version conflict occurred
        if (!orderResult.data || orderResult.data.version === values.version) {
          throw new Error('VERSION_CONFLICT');
        }
      } else {
        // Create new order
        const orderResult = await dataProvider().create({
          resource: 'orders',
          variables: values.header,
        });
        createdOrderId = orderResult.data.order_id;
      }

      console.log(`Order ${isEdit ? 'updated' : 'created'}: ${createdOrderId}`);

      // ========== STEP 2: Save order_details ==========
      if (values.details && values.details.length > 0) {
        const detailPromises = values.details.map((detail) => {
          const detailData = {
            ...detail,
            order_id: createdOrderId,
            temp_id: undefined, // Remove client-only field
          };

          if (detail.detail_id) {
            // Update existing detail
            return dataProvider().update({
              resource: 'order_details',
              id: detail.detail_id,
              variables: detailData,
            });
          } else {
            // Create new detail
            return dataProvider().create({
              resource: 'order_details',
              variables: detailData,
            });
          }
        });

        await Promise.all(detailPromises);
        console.log(`Saved ${values.details.length} order details`);
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
        console.log(`Deleted ${values.deletedDetails.length} order details`);
      }

      // ========== STEP 4: Save payments ==========
      if (values.payments && values.payments.length > 0) {
        const paymentPromises = values.payments.map((payment) => {
          const paymentData = {
            ...payment,
            order_id: createdOrderId,
            temp_id: undefined, // Remove client-only field
          };

          if (payment.payment_id) {
            // Update existing payment
            return dataProvider().update({
              resource: 'payments',
              id: payment.payment_id,
              variables: paymentData,
            });
          } else {
            // Create new payment
            return dataProvider().create({
              resource: 'payments',
              variables: paymentData,
            });
          }
        });

        await Promise.all(paymentPromises);
        console.log(`Saved ${values.payments.length} payments`);
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
        console.log(`Deleted ${values.deletedPayments.length} payments`);
      }

      // ========== STEP 6: Save workshops ==========
      if (values.workshops && values.workshops.length > 0) {
        const workshopPromises = values.workshops.map((workshop) => {
          const workshopData = {
            ...workshop,
            order_id: createdOrderId,
            temp_id: undefined, // Remove client-only field
          };

          if (workshop.order_workshop_id) {
            // Update existing workshop
            return dataProvider().update({
              resource: 'order_workshops',
              id: workshop.order_workshop_id,
              variables: workshopData,
            });
          } else {
            // Create new workshop
            return dataProvider().create({
              resource: 'order_workshops',
              variables: workshopData,
            });
          }
        });

        await Promise.all(workshopPromises);
        console.log(`Saved ${values.workshops.length} workshops`);
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
        console.log(`Deleted ${values.deletedWorkshops.length} workshops`);
      }

      // ========== STEP 8: Save requirements ==========
      if (values.requirements && values.requirements.length > 0) {
        const requirementPromises = values.requirements.map((requirement) => {
          const requirementData = {
            ...requirement,
            order_id: createdOrderId,
            temp_id: undefined, // Remove client-only field
          };

          if (requirement.requirement_id) {
            // Update existing requirement
            return dataProvider().update({
              resource: 'order_resource_requirements',
              id: requirement.requirement_id,
              variables: requirementData,
            });
          } else {
            // Create new requirement
            return dataProvider().create({
              resource: 'order_resource_requirements',
              variables: requirementData,
            });
          }
        });

        await Promise.all(requirementPromises);
        console.log(`Saved ${values.requirements.length} requirements`);
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
        console.log(`Deleted ${values.deletedRequirements.length} requirements`);
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

      // ========== SUCCESS ==========
      notification.success({
        message: `Заказ успешно ${isEdit ? 'обновлен' : 'создан'}`,
        description: `ID заказа: ${createdOrderId}`,
      });

      setIsSaving(false);
      return createdOrderId;
    } catch (err: any) {
      console.error('Error saving order:', err);
      setError(err);

      // ========== ROLLBACK: Delete created order if this was a create operation ==========
      if (createdOrderId && !isEdit) {
        try {
          await dataProvider().deleteOne({
            resource: 'orders',
            id: createdOrderId,
          });
          console.log(`Rollback: Deleted order ${createdOrderId}`);
        } catch (rollbackError) {
          console.error('Rollback failed:', rollbackError);
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
