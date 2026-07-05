export type GroupNotificationEventType =
  | 'GROUP_ORDER_LINKS_CHANGED'
  | 'GROUP_MEMBER_ADDED'
  | 'GROUP_MEMBER_REMOVED'
  | 'GROUP_DEADLINE_OVERDUE';

export interface GroupNotificationRecipient {
  userId: string;
  username: string | null;
  roleCode: string;
}

export interface GroupLinkedEntityRef {
  entityType: 'order' | 'deadline_instance' | 'user' | 'employee' | 'client' | 'workshop';
  entityId: string;
}

export interface GroupNotificationFact {
  factKey: string;
  groupId: string;
  linkedEntity: GroupLinkedEntityRef;
  auditRelated: {
    orderId?: string;
    deadlineId?: string;
    userId?: string;
    employeeId?: string;
  };
}

export interface GroupNotificationDelivery {
  recipientUserId: string;
  title: string;
  message: string;
}
