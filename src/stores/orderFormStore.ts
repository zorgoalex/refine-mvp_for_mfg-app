// Zustand Store for Order Form State Management
// Manages the entire order form state including header and all child tables

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import {
  Order,
  OrderDetail,
  Payment,
  OrderWorkshop,
  OrderResourceRequirement,
  OrderFormValues,
  OrderTotals,
} from '../types/orders';

// ============================================================================
// STATE INTERFACE
// ============================================================================

  interface OrderFormState {
  // ========== STATE ==========
  header: Partial<Order>;
  details: OrderDetail[];
  payments: Payment[];
  workshops: OrderWorkshop[];
  requirements: OrderResourceRequirement[];

  // Deleted items (track for deletion on server)
  deletedDetails: number[];
  deletedPayments: number[];
  deletedWorkshops: number[];
  deletedRequirements: number[];

    // Form metadata
    isDirty: boolean;
    version: number;
    isTotalAmountManual: boolean;

    // Originals loaded from server for change detection (keyed by persistent ID)
    originalDetails: Record<number, OrderDetail>;
    originalPayments: Record<number, Payment>;
    originalWorkshops: Record<number, OrderWorkshop>;
    originalRequirements: Record<number, OrderResourceRequirement>;

  // ========== ACTIONS: HEADER ==========
  setHeader: (data: Partial<Order>) => void;
  updateHeaderField: <K extends keyof Order>(field: K, value: Order[K]) => void;

  // ========== ACTIONS: DETAILS ==========
  addDetail: (detail: Omit<OrderDetail, 'temp_id'>) => void;
  insertDetailAfter: (afterTempId: number, detail: Omit<OrderDetail, 'temp_id'>) => void;
  updateDetail: (tempId: number, data: Partial<OrderDetail>) => void;
  deleteDetail: (tempId: number, detailId?: number) => void;
  reorderDetails: () => void; // Renumber detail_number

  // ========== ACTIONS: PAYMENTS ==========
  addPayment: (payment: Omit<Payment, 'temp_id'>) => void;
  updatePayment: (tempId: number, data: Partial<Payment>) => void;
  deletePayment: (tempId: number, paymentId?: number) => void;

  // ========== ACTIONS: WORKSHOPS ==========
  addWorkshop: (workshop: Omit<OrderWorkshop, 'temp_id'>) => void;
  updateWorkshop: (tempId: number, data: Partial<OrderWorkshop>) => void;
  deleteWorkshop: (tempId: number, workshopId?: number) => void;

  // ========== ACTIONS: REQUIREMENTS ==========
  addRequirement: (requirement: Omit<OrderResourceRequirement, 'temp_id'>) => void;
  updateRequirement: (tempId: number, data: Partial<OrderResourceRequirement>) => void;
  deleteRequirement: (tempId: number, requirementId?: number) => void;

  // ========== COMPUTED ==========
  calculatedTotals: () => OrderTotals;

  // ========== UTILITY ==========
  reset: () => void;
  loadOrder: (order: OrderFormValues) => void;
  getFormValues: () => OrderFormValues;
    setDirty: (isDirty: boolean) => void;
    syncOriginals: () => void;
    setTotalAmountManual: (isManual: boolean) => void;
}

// ============================================================================
// INITIAL STATE
// ============================================================================

  const initialState = {
    header: {},
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    deletedDetails: [],
    deletedPayments: [],
    deletedWorkshops: [],
    deletedRequirements: [],
    isDirty: false,
    version: 0,
    isTotalAmountManual: false,
    originalDetails: {},
    originalPayments: {},
    originalWorkshops: {},
    originalRequirements: {},
  };

// ============================================================================
// STORE
// ============================================================================

export const useOrderFormStore = create<OrderFormState>()(
  devtools(
    persist(
      (set, get) => ({
        // ========== INITIAL STATE ==========
        ...initialState,

        // ========== HEADER ACTIONS ==========
        setHeader: (data) =>
          set(
            (state) => ({
              header: { ...state.header, ...data },
              isDirty: true,
            }),
            false,
            'setHeader'
          ),

        updateHeaderField: (field, value) =>
          set(
            (state) => ({
              header: { ...state.header, [field]: value },
              isDirty: true,
            }),
            false,
            'updateHeaderField'
          ),

        // ========== DETAILS ACTIONS ==========
        addDetail: (detail) =>
          set(
            (state) => {
              // Calculate max detail_number
              const maxDetailNumber = state.details.reduce(
                (max, d) => Math.max(max, d.detail_number || 0),
                0
              );

              const newDetail = {
                ...detail,
                temp_id: Date.now(),
                detail_number: maxDetailNumber + 1,
                priority: detail.priority || 100,
                quantity: detail.quantity,
                delete_flag: false,
              };

              return {
                details: [...state.details, newDetail],
                isDirty: true,
              };
            },
            false,
            'addDetail'
          ),

        insertDetailAfter: (afterTempId, detail) =>
          set(
            (state) => {
              // Find the detail to insert after
              const afterDetail = state.details.find(
                (d) => d.temp_id === afterTempId || d.detail_id === afterTempId
              );

              // Get the new detail_number (after the found detail, or max+1 if not found)
              const afterNumber = afterDetail?.detail_number || 0;
              const newDetailNumber = afterNumber + 1;

              // Shift all details with detail_number >= newDetailNumber
              const shiftedDetails = state.details.map((d) => ({
                ...d,
                detail_number: (d.detail_number || 0) >= newDetailNumber
                  ? (d.detail_number || 0) + 1
                  : d.detail_number,
              }));

              // Add new detail with the calculated number
              const newDetail = {
                ...detail,
                temp_id: Date.now(),
                detail_number: newDetailNumber,
                priority: detail.priority || 100,
                quantity: detail.quantity,
                delete_flag: false,
              };

              return {
                details: [...shiftedDetails, newDetail],
                isDirty: true,
              };
            },
            false,
            'insertDetailAfter'
          ),

        updateDetail: (tempId, data) =>
          set(
            (state) => ({
              details: state.details.map((d) =>
                d.temp_id === tempId || d.detail_id === tempId ? { ...d, ...data } : d
              ),
              isDirty: true,
            }),
            false,
            'updateDetail'
          ),

        deleteDetail: (tempId, detailId) =>
          set(
            (state) => ({
              details: state.details.filter(
                (d) => d.temp_id !== tempId && d.detail_id !== tempId
              ),
              deletedDetails: detailId
                ? [...state.deletedDetails, detailId]
                : state.deletedDetails,
              isDirty: true,
            }),
            false,
            'deleteDetail'
          ),

        reorderDetails: () =>
          set(
            (state) => ({
              details: state.details.map((d, idx) => ({
                ...d,
                detail_number: idx + 1,
              })),
              isDirty: true,
            }),
            false,
            'reorderDetails'
          ),

        // ========== PAYMENTS ACTIONS ==========
        addPayment: (payment) =>
          set(
            (state) => ({
              payments: [
                ...state.payments,
                {
                  ...payment,
                  temp_id: Date.now(),
                },
              ],
              isDirty: true,
            }),
            false,
            'addPayment'
          ),

        updatePayment: (tempId, data) =>
          set(
            (state) => ({
              payments: state.payments.map((p) =>
                p.temp_id === tempId || p.payment_id === tempId ? { ...p, ...data } : p
              ),
              isDirty: true,
            }),
            false,
            'updatePayment'
          ),

        deletePayment: (tempId, paymentId) =>
          set(
            (state) => ({
              payments: state.payments.filter(
                (p) => p.temp_id !== tempId && p.payment_id !== tempId
              ),
              deletedPayments: paymentId
                ? [...state.deletedPayments, paymentId]
                : state.deletedPayments,
              isDirty: true,
            }),
            false,
            'deletePayment'
          ),

        // ========== WORKSHOPS ACTIONS ==========
        addWorkshop: (workshop) =>
          set(
            (state) => ({
              workshops: [
                ...state.workshops,
                {
                  ...workshop,
                  temp_id: Date.now(),
                  delete_flag: false,
                },
              ],
              isDirty: true,
            }),
            false,
            'addWorkshop'
          ),

        updateWorkshop: (tempId, data) =>
          set(
            (state) => ({
              workshops: state.workshops.map((w) =>
                w.temp_id === tempId || w.order_workshop_id === tempId
                  ? { ...w, ...data }
                  : w
              ),
              isDirty: true,
            }),
            false,
            'updateWorkshop'
          ),

        deleteWorkshop: (tempId, workshopId) =>
          set(
            (state) => ({
              workshops: state.workshops.filter(
                (w) => w.temp_id !== tempId && w.order_workshop_id !== tempId
              ),
              deletedWorkshops: workshopId
                ? [...state.deletedWorkshops, workshopId]
                : state.deletedWorkshops,
              isDirty: true,
            }),
            false,
            'deleteWorkshop'
          ),

        // ========== REQUIREMENTS ACTIONS ==========
        addRequirement: (requirement) =>
          set(
            (state) => ({
              requirements: [
                ...state.requirements,
                {
                  ...requirement,
                  temp_id: Date.now(),
                  is_active: true,
                },
              ],
              isDirty: true,
            }),
            false,
            'addRequirement'
          ),

        updateRequirement: (tempId, data) =>
          set(
            (state) => ({
              requirements: state.requirements.map((r) =>
                r.temp_id === tempId || r.requirement_id === tempId ? { ...r, ...data } : r
              ),
              isDirty: true,
            }),
            false,
            'updateRequirement'
          ),

        deleteRequirement: (tempId, requirementId) =>
          set(
            (state) => ({
              requirements: state.requirements.filter(
                (r) => r.temp_id !== tempId && r.requirement_id !== tempId
              ),
              deletedRequirements: requirementId
                ? [...state.deletedRequirements, requirementId]
                : state.deletedRequirements,
              isDirty: true,
            }),
            false,
            'deleteRequirement'
          ),

        // ========== COMPUTED ==========
        calculatedTotals: () => {
          const state = get();
          return {
            positions_count: state.details.length, // Количество позиций (записей)
            parts_count: state.details.reduce((sum, d) => sum + (d.quantity || 0), 0), // Количество деталей (сумма quantity)
            total_area: state.details.reduce((sum, d) => sum + (d.area || 0), 0),
            total_paid: state.payments.reduce((sum, p) => sum + (p.amount || 0), 0),
          };
        },

        // ========== UTILITY ==========
        reset: () => set(initialState, false, 'reset'),

        loadOrder: (order) =>
          set(
            {
              header: order.header || {},
              details:
                order.details?.map((d) => ({
                  ...d,
                  temp_id: d.detail_id || Date.now() + Math.random(),
                })) || [],
              payments:
                order.payments?.map((p) => ({
                  ...p,
                  temp_id: p.payment_id || Date.now() + Math.random(),
                })) || [],
              workshops:
                order.workshops?.map((w) => ({
                  ...w,
                  temp_id: w.order_workshop_id || Date.now() + Math.random(),
                })) || [],
              requirements:
                order.requirements?.map((r) => ({
                  ...r,
                  temp_id: r.requirement_id || Date.now() + Math.random(),
                })) || [],
              deletedDetails: [],
              deletedPayments: [],
              deletedWorkshops: [],
              deletedRequirements: [],
              isDirty: false,
              version: order.version || 0,
              isTotalAmountManual: false,
              // Build original maps for change detection
              originalDetails:
                order.details?.reduce((acc: Record<number, OrderDetail>, d) => {
                  if (d.detail_id) acc[d.detail_id] = { ...d } as OrderDetail;
                  return acc;
                }, {}) || {},
              originalPayments:
                order.payments?.reduce((acc: Record<number, Payment>, p) => {
                  if (p.payment_id) acc[p.payment_id] = { ...p } as Payment;
                  return acc;
                }, {}) || {},
              originalWorkshops:
                order.workshops?.reduce((acc: Record<number, OrderWorkshop>, w) => {
                  if (w.order_workshop_id) acc[w.order_workshop_id] = { ...w } as OrderWorkshop;
                  return acc;
                }, {}) || {},
              originalRequirements:
                order.requirements?.reduce((acc: Record<number, OrderResourceRequirement>, r) => {
                  if (r.requirement_id) acc[r.requirement_id] = { ...r } as OrderResourceRequirement;
                  return acc;
                }, {}) || {},
            },
            false,
            'loadOrder'
          ),

        getFormValues: () => {
          const state = get();
          console.log('[orderFormStore] getFormValues - state.header:', state.header);
          console.log('[orderFormStore] getFormValues - state.details:', state.details);
          console.log('[orderFormStore] getFormValues - details.length:', state.details.length);

          const formValues = {
            header: state.header as Order,
            details: state.details,
            payments: state.payments,
            workshops: state.workshops,
            requirements: state.requirements,
            deletedDetails: state.deletedDetails,
            deletedPayments: state.deletedPayments,
            deletedWorkshops: state.deletedWorkshops,
            deletedRequirements: state.deletedRequirements,
            isDirty: state.isDirty,
            version: state.version,
          };

          console.log('[orderFormStore] getFormValues - returning:', formValues);
          return formValues;
        },

        setDirty: (isDirty) => set({ isDirty }, false, 'setDirty'),

        // Rebuild originals from current state (after successful save)
        syncOriginals: () =>
          set(
            (state) => ({
              originalDetails: state.details.reduce((acc: Record<number, OrderDetail>, d) => {
                if (d.detail_id) acc[d.detail_id] = { ...d } as OrderDetail;
                return acc;
              }, {}),
              originalPayments: state.payments.reduce((acc: Record<number, Payment>, p) => {
                if (p.payment_id) acc[p.payment_id] = { ...p } as Payment;
                return acc;
              }, {}),
              originalWorkshops: state.workshops.reduce((acc: Record<number, OrderWorkshop>, w) => {
                if (w.order_workshop_id) acc[w.order_workshop_id] = { ...w } as OrderWorkshop;
                return acc;
              }, {}),
              originalRequirements: state.requirements.reduce((acc: Record<number, OrderResourceRequirement>, r) => {
                if (r.requirement_id) acc[r.requirement_id] = { ...r } as OrderResourceRequirement;
                return acc;
              }, {}),
              // Clear deleted trackers after sync
              deletedDetails: [],
              deletedPayments: [],
              deletedWorkshops: [],
              deletedRequirements: [],
            }),
            false,
            'syncOriginals'
          ),
        setTotalAmountManual: (isManual) =>
          set(
            () => ({
              isTotalAmountManual: isManual,
            }),
            false,
            'setTotalAmountManual'
          ),
      }),
      {
        name: 'order-form-storage',
        // Only persist essential data for draft recovery
        partialize: (state) => ({
          header: state.header,
          details: state.details,
          payments: state.payments,
          workshops: state.workshops,
          requirements: state.requirements,
          isDirty: state.isDirty,
          version: state.version,
          isTotalAmountManual: state.isTotalAmountManual,
          // Do not persist originals to local storage
        }),
      }
    ),
    {
      name: 'OrderFormStore',
    }
  )
);

// ============================================================================
// SELECTORS (for optimized access)
// ============================================================================

export const selectHeader = (state: OrderFormState) => state.header;
export const selectDetails = (state: OrderFormState) => state.details;
export const selectPayments = (state: OrderFormState) => state.payments;
export const selectWorkshops = (state: OrderFormState) => state.workshops;
export const selectRequirements = (state: OrderFormState) => state.requirements;
export const selectIsDirty = (state: OrderFormState) => state.isDirty;
export const selectTotals = (state: OrderFormState) => state.calculatedTotals();
