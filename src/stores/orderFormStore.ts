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
  OrderDowelingLink,
  OrderFormValues,
  OrderTotals,
} from '../types/orders';

// ============================================================================
// UNIQUE ID GENERATOR
// ============================================================================

let tempIdCounter = 0;
const generateTempId = (): number => {
  tempIdCounter += 1;
  return Date.now() * 1000 + tempIdCounter;
};

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
  dowelingLinks: OrderDowelingLink[];

  // Deleted items (track for deletion on server)
  deletedDetails: number[];
  deletedPayments: number[];
  deletedWorkshops: number[];
  deletedRequirements: number[];
  deletedDowelingLinks: number[];

    // Form metadata
    isDirty: boolean;
    isInitializing: boolean;
    version: number;
    isTotalAmountManual: boolean;
    isPaymentStatusManual: boolean;
    isDetailEditing: boolean;
    isPaymentEditing: boolean;

    // Original header values loaded from server (for change detection after recalculations)
    originalHeader: Partial<Order>;

    // Originals loaded from server for change detection (keyed by persistent ID)
    originalDetails: Record<number, OrderDetail>;
    originalPayments: Record<number, Payment>;
    originalWorkshops: Record<number, OrderWorkshop>;
    originalRequirements: Record<number, OrderResourceRequirement>;
    originalDowelingLinks: Record<number, OrderDowelingLink>;

  // ========== ACTIONS: HEADER ==========
  setHeader: (data: Partial<Order>) => void;
  updateHeaderField: <K extends keyof Order>(field: K, value: Order[K]) => void;

  // ========== ACTIONS: DETAILS ==========
  addDetail: (detail: Omit<OrderDetail, 'temp_id'>) => void;
  insertDetailAfter: (afterTempId: number, detail: Omit<OrderDetail, 'temp_id'>) => void;
  updateDetail: (tempId: number, data: Partial<OrderDetail>) => void;
  updateDetailId: (tempId: number, detailId: number) => void; // Update detail_id after DB create
  deleteDetail: (tempId: number, detailId?: number) => void;
  reorderDetails: () => void; // Renumber detail_number

  // ========== ACTIONS: PAYMENTS ==========
  addPayment: (payment: Omit<Payment, 'temp_id'>) => void;
  updatePayment: (tempId: number, data: Partial<Payment>) => void;
  updatePaymentId: (tempId: number, paymentId: number) => void; // Update payment_id after DB create
  deletePayment: (tempId: number, paymentId?: number) => void;

  // ========== ACTIONS: WORKSHOPS ==========
  addWorkshop: (workshop: Omit<OrderWorkshop, 'temp_id'>) => void;
  updateWorkshop: (tempId: number, data: Partial<OrderWorkshop>) => void;
  deleteWorkshop: (tempId: number, workshopId?: number) => void;

  // ========== ACTIONS: REQUIREMENTS ==========
  addRequirement: (requirement: Omit<OrderResourceRequirement, 'temp_id'>) => void;
  updateRequirement: (tempId: number, data: Partial<OrderResourceRequirement>) => void;
  deleteRequirement: (tempId: number, requirementId?: number) => void;

  // ========== ACTIONS: DOWELING LINKS ==========
  addDowelingLink: (link: Omit<OrderDowelingLink, 'temp_id'>) => void;
  updateDowelingLink: (tempId: number, data: Partial<OrderDowelingLink>) => void;
  deleteDowelingLink: (tempId: number, linkId?: number) => void;

  // ========== COMPUTED ==========
  calculatedTotals: () => OrderTotals;
  recalculateFinancials: () => void; // Recalculate total_amount and final_amount from details

  // ========== UTILITY ==========
  reset: () => void;
  loadOrder: (order: OrderFormValues) => void;
  getFormValues: () => OrderFormValues;
    setDirty: (isDirty: boolean) => void;
    setInitializing: (isInitializing: boolean) => void;
    finalizeInitialization: () => void;
    syncOriginals: () => void;
    setTotalAmountManual: (isManual: boolean) => void;
    setPaymentStatusManual: (isManual: boolean) => void;
    setDetailEditing: (isEditing: boolean) => void;
    setPaymentEditing: (isEditing: boolean) => void;
}

// ============================================================================
// INITIAL STATE
// ============================================================================

  const initialState = {
    header: {
      priority: 100,
      production_status_from_details_enabled: true, // По умолчанию автообновление включено
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deletedDetails: [],
    deletedPayments: [],
    deletedWorkshops: [],
    deletedRequirements: [],
    deletedDowelingLinks: [],
    isDirty: false,
    isInitializing: false,
    version: 0,
    isTotalAmountManual: false,
    isPaymentStatusManual: false,
    isDetailEditing: false,
    isPaymentEditing: false,
    originalHeader: {},
    originalDetails: {},
    originalPayments: {},
    originalWorkshops: {},
    originalRequirements: {},
    originalDowelingLinks: {},
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
              // Не устанавливаем isDirty во время инициализации (пересчёты после loadOrder)
              isDirty: state.isInitializing ? state.isDirty : true,
            }),
            false,
            'updateHeaderField'
          ),

        // ========== DETAILS ACTIONS ==========
        addDetail: (detail) => {
          set(
            (state) => {
              // Calculate max detail_number
              const maxDetailNumber = state.details.reduce(
                (max, d) => Math.max(max, d.detail_number || 0),
                0
              );

              const newDetail = {
                ...detail,
                temp_id: generateTempId(),
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
          );
          // Recalculate financials after detail add
          get().recalculateFinancials();
        },

        insertDetailAfter: (afterTempId, detail) => {
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
                temp_id: generateTempId(),
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
          );
          // Recalculate financials after detail insert
          get().recalculateFinancials();
        },

        updateDetail: (tempId, data) => {
          set(
            (state) => ({
              details: state.details.map((d) =>
                d.temp_id === tempId || d.detail_id === tempId ? { ...d, ...data } : d
              ),
              isDirty: true,
            }),
            false,
            'updateDetail'
          );
          // Recalculate financials after detail update
          get().recalculateFinancials();
        },

        // Update detail_id after successful DB create (to prevent duplicates on next save)
        updateDetailId: (tempId, detailId) =>
          set(
            (state) => ({
              details: state.details.map((d) =>
                d.temp_id === tempId ? { ...d, detail_id: detailId } : d
              ),
            }),
            false,
            'updateDetailId'
          ),

        deleteDetail: (tempId, detailId) => {
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
          );
          // Recalculate financials after detail delete
          get().recalculateFinancials();
        },

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

        // Update payment_id after successful DB create (to prevent duplicates on next save)
        updatePaymentId: (tempId, paymentId) =>
          set(
            (state) => ({
              payments: state.payments.map((p) =>
                p.temp_id === tempId ? { ...p, payment_id: paymentId } : p
              ),
            }),
            false,
            'updatePaymentId'
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

        // ========== DOWELING LINKS ACTIONS ==========
        addDowelingLink: (link) =>
          set(
            (state) => ({
              dowelingLinks: [
                ...state.dowelingLinks,
                {
                  ...link,
                  temp_id: Date.now(),
                  delete_flag: false,
                },
              ],
              isDirty: true,
            }),
            false,
            'addDowelingLink'
          ),

        updateDowelingLink: (tempId, data) =>
          set(
            (state) => ({
              dowelingLinks: state.dowelingLinks.map((l) =>
                (l.temp_id === tempId || l.order_doweling_link_id === tempId)
                  ? { ...l, ...data }
                  : l
              ),
              isDirty: true,
            }),
            false,
            'updateDowelingLink'
          ),

        deleteDowelingLink: (tempId, linkId) =>
          set(
            (state) => ({
              dowelingLinks: state.dowelingLinks.filter(
                (l) => l.temp_id !== tempId && l.order_doweling_link_id !== tempId
              ),
              deletedDowelingLinks: linkId
                ? [...state.deletedDowelingLinks, linkId]
                : state.deletedDowelingLinks,
              isDirty: true,
            }),
            false,
            'deleteDowelingLink'
          ),

        // ========== COMPUTED ==========
        calculatedTotals: () => {
          const state = get();
          return {
            positions_count: state.details.length, // Количество позиций (записей)
            parts_count: state.details.reduce((sum, d) => sum + (d.quantity || 0), 0), // Количество деталей (сумма quantity)
            total_area: state.details.reduce((sum, d) => sum + (d.area || 0), 0),
            total_paid: state.payments.reduce((sum, p) => sum + (p.amount || 0), 0),
            total_amount: state.details.reduce((sum, d) => sum + (d.detail_cost || 0), 0), // Сумма всех detail_cost
          };
        },

        // Recalculate total_amount and final_amount from details in real-time
        // Note: Must update final_amount synchronously here, not via useEffect,
        // because validation happens before useEffect can run
        recalculateFinancials: () =>
          set(
            (state) => {
              const totalAmount = state.details.reduce((sum, d) => sum + (d.detail_cost || 0), 0);
              const discount = state.header.discount || 0;
              const surcharge = state.header.surcharge || 0;
              // Formula: final_amount = total_amount - discount + surcharge
              const finalAmount = surcharge > 0
                ? Number((totalAmount + surcharge).toFixed(2))
                : Math.max(0, Number((totalAmount - discount).toFixed(2)));

              return {
                header: {
                  ...state.header,
                  total_amount: totalAmount,
                  final_amount: finalAmount,
                },
              };
            },
            false,
            'recalculateFinancials'
          ),

        // ========== UTILITY ==========
        reset: () => set(initialState, false, 'reset'),

        loadOrder: (order) =>
          set(
            {
              header: {
                ...(order.header || {}),
                // Ensure priority defaults to 100 if not set or invalid
                priority: (order.header?.priority && order.header.priority >= 1) ? order.header.priority : 100,
              },
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
              dowelingLinks:
                order.dowelingLinks?.map((l) => ({
                  ...l,
                  temp_id: l.order_doweling_link_id || Date.now() + Math.random(),
                })) || [],
              deletedDetails: [],
              deletedPayments: [],
              deletedWorkshops: [],
              deletedRequirements: [],
              deletedDowelingLinks: [],
              isDirty: false,
              isInitializing: true, // Mark as initializing to prevent isDirty from being set during recalculations
              version: order.version || 0,
              isTotalAmountManual: false,
              isDetailEditing: false,
              isPaymentEditing: false,
              // Save original header values for comparison after recalculations
              originalHeader: { ...(order.header || {}) },
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
              originalDowelingLinks:
                order.dowelingLinks?.reduce((acc: Record<number, OrderDowelingLink>, l) => {
                  if (l.order_doweling_link_id) acc[l.order_doweling_link_id] = { ...l } as OrderDowelingLink;
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
            dowelingLinks: state.dowelingLinks,
            deletedDetails: state.deletedDetails,
            deletedPayments: state.deletedPayments,
            deletedWorkshops: state.deletedWorkshops,
            deletedRequirements: state.deletedRequirements,
            deletedDowelingLinks: state.deletedDowelingLinks,
            isDirty: state.isDirty,
            version: state.version,
          };

          console.log('[orderFormStore] getFormValues - returning:', formValues);
          return formValues;
        },

        setDirty: (isDirty) => set({ isDirty }, false, 'setDirty'),

        setInitializing: (isInitializing) => set({ isInitializing }, false, 'setInitializing'),

        // Finalize initialization: compare current header with original and set isDirty if there are real changes
        finalizeInitialization: () =>
          set(
            (state) => {
              // Compare calculated fields with original values
              const original = state.originalHeader;
              const current = state.header;

              // Helper to compare numbers with tolerance for floating point errors
              const numbersEqual = (a: number | undefined | null, b: number | undefined | null, tolerance = 0.01): boolean => {
                const valA = a ?? 0;
                const valB = b ?? 0;
                return Math.abs(valA - valB) < tolerance;
              };

              // Check if any calculated field has a real difference from original
              const hasRealChanges =
                !numbersEqual(current.total_amount, original.total_amount) ||
                !numbersEqual(current.final_amount, original.final_amount) ||
                !numbersEqual(current.paid_amount, original.paid_amount) ||
                (current.payment_status_id !== original.payment_status_id && original.payment_status_id !== undefined);

              if (hasRealChanges) {
                console.log('[orderFormStore] finalizeInitialization - detected real changes during recalculation:', {
                  total_amount: { original: original.total_amount, current: current.total_amount },
                  final_amount: { original: original.final_amount, current: current.final_amount },
                  paid_amount: { original: original.paid_amount, current: current.paid_amount },
                  payment_status_id: { original: original.payment_status_id, current: current.payment_status_id },
                });
              }

              return {
                isInitializing: false,
                isDirty: hasRealChanges,
              };
            },
            false,
            'finalizeInitialization'
          ),

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
              originalDowelingLinks: state.dowelingLinks.reduce((acc: Record<number, OrderDowelingLink>, l) => {
                if (l.order_doweling_link_id) acc[l.order_doweling_link_id] = { ...l } as OrderDowelingLink;
                return acc;
              }, {}),
              // Clear deleted trackers after sync
              deletedDetails: [],
              deletedPayments: [],
              deletedWorkshops: [],
              deletedRequirements: [],
              deletedDowelingLinks: [],
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
        setPaymentStatusManual: (isManual) =>
          set(
            () => ({
              isPaymentStatusManual: isManual,
            }),
            false,
            'setPaymentStatusManual'
          ),

        setDetailEditing: (isEditing) =>
          set(
            (state) => ({
              isDetailEditing: isEditing,
              // When starting edit, mark form as dirty
              isDirty: isEditing ? true : state.isDirty,
            }),
            false,
            'setDetailEditing'
          ),

        setPaymentEditing: (isEditing) =>
          set(
            (state) => ({
              isPaymentEditing: isEditing,
              // When starting edit, mark form as dirty
              isDirty: isEditing ? true : state.isDirty,
            }),
            false,
            'setPaymentEditing'
          ),
      }),
      {
        name: 'order-form-storage',
        version: 3, // Increment to force migration from old storage
        // Only persist essential data for draft recovery
        partialize: (state) => ({
          header: state.header,
          details: state.details,
          payments: state.payments,
          workshops: state.workshops,
          requirements: state.requirements,
          dowelingLinks: state.dowelingLinks,
          isDirty: state.isDirty,
          version: state.version,
          isTotalAmountManual: state.isTotalAmountManual,
          // Do not persist originals to local storage
        }),
        // Migrate old storage versions
        migrate: (persistedState: any, version: number) => {
          // Fix priority default value (always check, regardless of version)
          if (persistedState?.header) {
            if (!persistedState.header.priority || persistedState.header.priority < 1) {
              persistedState.header.priority = 100;
            }
          }
          return persistedState;
        },
        // Merge persisted state with initial state, ensuring defaults
        merge: (persistedState: any, currentState) => ({
          ...currentState,
          ...persistedState,
          header: {
            ...currentState.header,
            ...persistedState?.header,
            // Ensure priority defaults to 100 if not set or invalid
            priority: (persistedState?.header?.priority && persistedState.header.priority >= 1)
              ? persistedState.header.priority
              : 100,
          },
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
export const selectDowelingLinks = (state: OrderFormState) => state.dowelingLinks;
export const selectIsDirty = (state: OrderFormState) => state.isDirty;
export const selectTotals = (state: OrderFormState) => state.calculatedTotals();
