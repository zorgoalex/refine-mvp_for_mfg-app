export type ProjectNotificationEventType =
  | 'PROJECT_ORDER_LINKS_CHANGED'
  | 'PROJECT_MEMBER_ADDED'
  | 'PROJECT_MEMBER_REMOVED'
  | 'PROJECT_DEADLINE_OVERDUE';

export interface ProjectNotificationRecipient {
  userId: string;
  username: string | null;
  roleCode: string;
}

export interface ProjectLinkedEntityRef {
  entityType: 'order' | 'deadline_instance' | 'user' | 'employee' | 'client' | 'workshop';
  entityId: string;
}

export interface ProjectNotificationFact {
  factKey: string;
  projectId: string;
  linkedEntity: ProjectLinkedEntityRef;
  auditRelated: {
    orderId?: string;
    deadlineId?: string;
    userId?: string;
    employeeId?: string;
  };
}

export interface ProjectNotificationDelivery {
  recipientUserId: string;
  title: string;
  message: string;
}
