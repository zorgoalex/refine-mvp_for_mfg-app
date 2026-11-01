/**
 * «Переделка» 1.1 §6.3: the executor of background/repair reconciliations of an order's final deadline. Deadline rows
 * reference users, so this actor is stored as NULL user ids and named in the event payloads; the user who asked for
 * the reconciliation is the initiator.
 */
export const ORDER_FINAL_DEADLINE_SYSTEM_ACTOR = 'system:order-final-deadline-reconcile';
