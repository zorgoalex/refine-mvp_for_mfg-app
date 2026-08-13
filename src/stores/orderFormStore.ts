// Zustand Store for Order Form State Management
// Manages the entire order form state including header and all child tables

import React, { createContext, useContext } from 'react';
import { create, useStore, type StoreApi, type UseBoundStore } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import {
  Order,
  OrderDetail,
  OrderHdfDetail,
  Payment,
  OrderWorkshop,
  OrderResourceRequirement,
  OrderDowelingLink,
  OrderFormValues,
  OrderTotals,
} from '../types/orders';
import { calculateOrderTotalArea } from '../utils/orderArea';

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
  hdfDetails: OrderHdfDetail[];
  dirtyHdfDetailIds: number[];
  payments: Payment[];
  workshops: OrderWorkshop[];
  requirements: OrderResourceRequirement[];
  dowelingLinks: OrderDowelingLink[];
  pdfImportCandidateTempIds: number[];

  // Deleted items (track for deletion on server)
  deletedDetails: number[];
  deletedHdfDetails: number[];
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
  addPdfImportedDetail: (detail: Omit<OrderDetail, 'temp_id'>) => void;
  insertDetailAfter: (afterTempId: number, detail: Omit<OrderDetail, 'temp_id'>) => void;
  updateDetail: (tempId: number, data: Partial<OrderDetail>) => void;
  updateDetailId: (tempId: number, detailId: number) => void; // Update detail_id after DB create
  syncDetailsProductionStatus: (productionStatusId: number) => void;
  deleteDetail: (tempId: number, detailId?: number) => void;
  reorderDetails: () => void; // Renumber detail_number

  // ========== ACTIONS: HDF DETAILS ==========
  updateHdfDetail: (hdfDetailId: number, data: Partial<OrderHdfDetail>) => void;

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
  applyOrderRefresh: (details: OrderDetail[], version: number) => void;
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
    hdfDetails: [],
    dirtyHdfDetailIds: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    pdfImportCandidateTempIds: [],
    deletedDetails: [],
    deletedHdfDetails: [],
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
// STORE FACTORY (per-order draft isolation)
// ============================================================================

const DRAFT_STORAGE_PREFIX = 'order-form-storage';
const draftStorageKey = (orderKey: string) => `${DRAFT_STORAGE_PREFIX}:${orderKey}`;

type OrderDraftStore = UseBoundStore<StoreApi<OrderFormState>>;

const createOrderDraftStore = (orderKey: string): OrderDraftStore =>
  create<OrderFormState>()(
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
              version: typeof data.version === 'number' ? data.version : state.version,
              isDirty: true,
            }),
            false,
            'setHeader'
          ),

        updateHeaderField: (field, value) =>
          set(
            (state) => ({
              header: { ...state.header, [field]: value },
              version: field === 'version' && typeof value === 'number' ? value : state.version,
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

        addPdfImportedDetail: (detail) => {
          set(
            (state) => {
              const maxDetailNumber = state.details.reduce(
                (max, current) => Math.max(max, current.detail_number || 0),
                0,
              );
              const tempId = generateTempId();
              return {
                details: [
                  ...state.details,
                  {
                    ...detail,
                    temp_id: tempId,
                    detail_number: maxDetailNumber + 1,
                    priority: detail.priority || 100,
                    quantity: detail.quantity,
                    delete_flag: false,
                  },
                ],
                pdfImportCandidateTempIds: [...state.pdfImportCandidateTempIds, tempId],
                isDirty: true,
              };
            },
            false,
            'addPdfImportedDetail',
          );
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
                bazisNodeId: undefined,
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

        syncDetailsProductionStatus: (productionStatusId) =>
          set(
            (state) => ({
              details: state.details.map((detail) => ({
                ...detail,
                production_status_id: productionStatusId,
              })),
              originalDetails: Object.fromEntries(
                Object.entries(state.originalDetails).map(([detailId, detail]) => [
                  detailId,
                  { ...detail, production_status_id: productionStatusId },
                ]),
              ) as Record<number, OrderDetail>,
            }),
            false,
            'syncDetailsProductionStatus'
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
              pdfImportCandidateTempIds: state.pdfImportCandidateTempIds.filter(
                (candidateTempId) => candidateTempId !== tempId,
              ),
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

        // ========== HDF DETAILS ACTIONS ==========
        updateHdfDetail: (hdfDetailId, data) =>
          set(
            (state) => ({
              hdfDetails: state.hdfDetails.map((detail) =>
                detail.order_hdf_detail_id === hdfDetailId ? { ...detail, ...data } : detail,
              ),
              dirtyHdfDetailIds: state.dirtyHdfDetailIds.includes(hdfDetailId)
                ? state.dirtyHdfDetailIds
                : [...state.dirtyHdfDetailIds, hdfDetailId],
              isDirty: state.isInitializing ? state.isDirty : true,
            }),
            false,
            'updateHdfDetail'
          ),

        // ========== PAYMENTS ACTIONS ==========
        addPayment: (payment) =>
          set(
            (state) => ({
              payments: [
                ...state.payments,
                {
                  ...payment,
                  temp_id: generateTempId(),
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
                  temp_id: generateTempId(),
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
                  temp_id: generateTempId(),
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
                  temp_id: generateTempId(),
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
            total_area: calculateOrderTotalArea(state.details),
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
              // temp_id обязан быть уникален в пределах формы: он становится
              // clientKey для bazis create-from-draft. Date.now()+Math.random()
              // в одной мс различает лишь ~2048 значений (мантисса double) —
              // на больших драфтах (214 панелей) коллизии гарантированы.
              details:
                order.details?.map((d) => ({
                  ...d,
                  temp_id: d.detail_id || generateTempId(),
                })) || [],
              hdfDetails: order.hdfDetails || [],
              dirtyHdfDetailIds: [],
              payments:
                order.payments?.map((p) => ({
                  ...p,
                  temp_id: p.payment_id || generateTempId(),
                })) || [],
              workshops:
                order.workshops?.map((w) => ({
                  ...w,
                  temp_id: w.order_workshop_id || generateTempId(),
                })) || [],
              requirements:
                order.requirements?.map((r) => ({
                  ...r,
                  temp_id: r.requirement_id || generateTempId(),
                })) || [],
              dowelingLinks:
                order.dowelingLinks?.map((l) => ({
                  ...l,
                  temp_id: l.order_doweling_link_id || generateTempId(),
                })) || [],
              deletedDetails: [],
              deletedHdfDetails: [],
              deletedPayments: [],
              deletedWorkshops: [],
              deletedRequirements: [],
              deletedDowelingLinks: [],
              pdfImportCandidateTempIds: [],
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

        applyOrderRefresh: (details, version) =>
          set(
            (state) => ({
              details,
              version,
              header: { ...state.header, version },
            }),
            false,
            'applyOrderRefresh'
          ),

        getFormValues: () => {
          const state = get();
          console.log('[orderFormStore] getFormValues - state.header:', state.header);
          console.log('[orderFormStore] getFormValues - state.details:', state.details);
          console.log('[orderFormStore] getFormValues - details.length:', state.details.length);

          const formValues = {
            header: state.header as Order,
            details: state.details,
            hdfDetails: state.hdfDetails,
            dirtyHdfDetailIds: state.dirtyHdfDetailIds,
            payments: state.payments,
            workshops: state.workshops,
            requirements: state.requirements,
            dowelingLinks: state.dowelingLinks,
            pdfImportCandidateTempIds: state.pdfImportCandidateTempIds,
            deletedDetails: state.deletedDetails,
            deletedHdfDetails: state.deletedHdfDetails,
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
              deletedHdfDetails: [],
              dirtyHdfDetailIds: [],
              deletedPayments: [],
              deletedWorkshops: [],
              deletedRequirements: [],
              deletedDowelingLinks: [],
              pdfImportCandidateTempIds: [],
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
        name: draftStorageKey(orderKey),
        storage: createJSONStorage(() => sessionStorage),
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
      name: `orderFormStore:${orderKey}`,
    }
  )
);

// ============================================================================
// STORE REGISTRY
// ============================================================================

const orderDraftStores = new Map<string, OrderDraftStore>();

export const NEW_ORDER_KEY = 'new';

export const getOrderDraftStore = (orderKey: string): OrderDraftStore => {
  let store = orderDraftStores.get(orderKey);
  if (!store) {
    store = createOrderDraftStore(orderKey);
    orderDraftStores.set(orderKey, store);
  }
  return store;
};

/**
 * Non-creating lookup. Unlike getOrderDraftStore it never resurrects a destroyed
 * slice — use it for late/in-flight completions (save/load resolving after the tab
 * was discarded) so a stale write cannot recreate the Map entry + sessionStorage.
 */
export const peekOrderDraftStore = (orderKey: string): OrderDraftStore | undefined =>
  orderDraftStores.get(orderKey);

export const destroyOrderDraftStore = (orderKey: string): void => {
  orderDraftStores.delete(orderKey);
  try {
    sessionStorage.removeItem(draftStorageKey(orderKey));
  } catch {
    /* sessionStorage unavailable */
  }
};

export const orderDraftStoreExists = (orderKey: string): boolean =>
  orderDraftStores.has(orderKey);

// Scoped hook: subscribe to a specific order's draft store.
export function useOrderDraftStore(orderKey: string): OrderFormState;
export function useOrderDraftStore<T>(orderKey: string, selector: (s: OrderFormState) => T): T;
export function useOrderDraftStore<T>(orderKey: string, selector?: (s: OrderFormState) => T) {
  const store = getOrderDraftStore(orderKey);
  return selector ? useStore(store, selector) : useStore(store);
}

// ============================================================================
// STORE CONTEXT (scope the active order's store down the OrderForm subtree)
// ============================================================================

const OrderDraftStoreContext = createContext<OrderDraftStore | null>(null);

export const OrderDraftStoreProvider: React.FC<{ orderKey: string; children: React.ReactNode }> = ({
  orderKey,
  children,
}) =>
  React.createElement(
    OrderDraftStoreContext.Provider,
    { value: getOrderDraftStore(orderKey) },
    children,
  );

/** Imperative StoreApi for the active scope (.getState()/.setState()/.subscribe()). Fallback = "new". */
export const useOrderDraftStoreApi = (): OrderDraftStore =>
  useContext(OrderDraftStoreContext) ?? getOrderDraftStore(NEW_ORDER_KEY);

/** Context-aware hook: subscribes to the active scope's store (or "new" with no provider). */
function useOrderFormStoreHook(): OrderFormState;
function useOrderFormStoreHook<T>(selector: (s: OrderFormState) => T): T;
function useOrderFormStoreHook<T>(selector?: (s: OrderFormState) => T) {
  const store = useContext(OrderDraftStoreContext) ?? getOrderDraftStore(NEW_ORDER_KEY);
  return selector ? useStore(store, selector) : useStore(store);
}

// Context-aware hook + static accessors bound to the "new" store (back-compat for
// non-provider callers: import modals, create flow, version-sync unit test).
export const useOrderFormStore = Object.assign(useOrderFormStoreHook, {
  getState: () => getOrderDraftStore(NEW_ORDER_KEY).getState(),
  setState: (...a: any[]) => (getOrderDraftStore(NEW_ORDER_KEY).setState as any)(...a),
  subscribe: (...a: any[]) => (getOrderDraftStore(NEW_ORDER_KEY).subscribe as any)(...a),
}) as typeof useOrderFormStoreHook & {
  getState: () => OrderFormState;
  setState: StoreApi<OrderFormState>['setState'];
  subscribe: StoreApi<OrderFormState>['subscribe'];
};

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
