import { describe, expect, it } from 'vitest';
import type { NotificationRuleDto } from '../../../api/types/notificationRulesApi.types';
import {
  buildCreatePayload,
  buildDraftFromRule,
  buildUpdatePayload,
  canManageNotificationRules,
  canViewNotificationRules,
  emptyDraft,
  parseIdList,
  parseRoleCodeList,
  type NotificationRuleDraft,
} from './notificationRulesView';

const baseRule: NotificationRuleDto = {
  notificationRuleId: '11111111-1111-4111-8111-111111111111',
  ruleCode: 'notify-overdue-manager',
  eventType: 'order.production_status_changed',
  isEnabled: true,
  priority: 100,
  level: 'warning',
  conditions: {
    excludeCompletedOrders: true,
    excludeOrderStatusIds: [7, 8],
  },
  recipients: {
    resolvers: ['order_manager'],
    roleCodes: ['admin'],
  },
  titleTemplate: 'Deadline expired',
  messageTemplate: 'Order {orderId} deadline expired',
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

describe('notificationRulesView', () => {
  describe('parseIdList', () => {
    it('parses a comma/space id list, dropping blanks and non-numbers', () => {
      expect(parseIdList('1, 2,  3')).toEqual([1, 2, 3]);
      expect(parseIdList('')).toEqual([]);
      expect(parseIdList('x, 4')).toEqual([4]);
      expect(parseIdList(' 5 , 6,foo,0')).toEqual([5, 6]);
    });
  });

  describe('parseRoleCodeList', () => {
    it('parses a comma/space role code list, dropping blanks and trimming', () => {
      expect(parseRoleCodeList('admin, top_manager  ')).toEqual(['admin', 'top_manager']);
      expect(parseRoleCodeList('')).toEqual([]);
      expect(parseRoleCodeList('   ')).toEqual([]);
    });
  });

  describe('buildCreatePayload', () => {
    it('assembles conditions/recipients, omits empty arrays, normalizes empty templates to null', () => {
      const draft: NotificationRuleDraft = {
        ruleCode: 'notify-overdue-manager',
        eventType: 'order.production_status_changed',
        level: 'warning',
        priority: 100,
        isEnabled: true,
        excludeCompletedOrders: true,
        allowedFromOrderStatusIdsText: '',
        excludeOrderStatusIdsText: '7,8',
        resolvers: ['order_manager'],
        roleCodesText: 'admin',
        userIdsText: '',
        titleTemplate: '',
        messageTemplate: 'Order {orderId}',
      };

      expect(buildCreatePayload(draft)).toEqual({
        ruleCode: 'notify-overdue-manager',
        eventType: 'order.production_status_changed',
        level: 'warning',
        priority: 100,
        isEnabled: true,
        conditions: {
          excludeCompletedOrders: true,
          excludeOrderStatusIds: [7, 8],
        },
        recipients: {
          resolvers: ['order_manager'],
          roleCodes: ['admin'],
        },
        titleTemplate: null,
        messageTemplate: 'Order {orderId}',
      });
    });

    it('includes allowedFromOrderStatusIds and userIds when present', () => {
      const draft: NotificationRuleDraft = {
        ...emptyDraft(),
        ruleCode: 'r',
        eventType: 'order.status_changed',
        allowedFromOrderStatusIdsText: '1, 2',
        userIdsText: '100, 200',
        resolvers: [],
        excludeCompletedOrders: false,
      };

      const payload = buildCreatePayload(draft);
      expect(payload.conditions).toEqual({ allowedFromOrderStatusIds: [1, 2] });
      expect(payload.recipients).toEqual({ userIds: [100, 200] });
    });
  });

  describe('buildUpdatePayload', () => {
    it('includes reason and expectedUpdatedAt, always sends conditions, omits empty recipients', () => {
      const result = buildUpdatePayload(
        { priority: 50, isEnabled: false } as NotificationRuleDraft,
        'tuning',
        '2026-06-10T00:00:00.000Z',
      );

      expect(result.priority).toBe(50);
      expect(result.isEnabled).toBe(false);
      expect(result.reason).toBe('tuning');
      expect(result.expectedUpdatedAt).toBe('2026-06-10T00:00:00.000Z');
      // conditions is ALWAYS present (even {}) so a cleared edit actually clears
      // instead of silently keeping the backend's existing conditions.
      expect(result.conditions).toEqual({});
      // recipients omission is harmless — backend rejects empty recipients.
      expect(result.recipients).toBeUndefined();
    });

    it('clearing all conditions on edit sends an explicit empty object (not omitted)', () => {
      // Draft built from a rule that previously had conditions, then cleared in
      // the form (unchecked excludeCompletedOrders, blanked both id lists).
      const cleared = buildDraftFromRule(baseRule);
      cleared.excludeCompletedOrders = false;
      cleared.allowedFromOrderStatusIdsText = '';
      cleared.excludeOrderStatusIdsText = '';

      const result = buildUpdatePayload(cleared, 'remove gating', '2026-06-10T00:00:00.000Z');

      // Must be present and empty so the backend clears conditions_json.
      expect(result.conditions).toEqual({});
      expect('conditions' in result).toBe(true);
    });
  });

  describe('buildDraftFromRule + emptyDraft', () => {
    it('round-trips a rule into the editable draft shape', () => {
      const draft = buildDraftFromRule(baseRule);
      expect(draft).toEqual({
        ruleCode: 'notify-overdue-manager',
        eventType: 'order.production_status_changed',
        level: 'warning',
        priority: 100,
        isEnabled: true,
        excludeCompletedOrders: true,
        allowedFromOrderStatusIdsText: '',
        excludeOrderStatusIdsText: '7, 8',
        resolvers: ['order_manager'],
        roleCodesText: 'admin',
        userIdsText: '',
        titleTemplate: 'Deadline expired',
        messageTemplate: 'Order {orderId} deadline expired',
      });
    });

    it('emptyDraft returns safe defaults', () => {
      const draft = emptyDraft();
      expect(draft.ruleCode).toBe('');
      expect(draft.eventType).toBe('');
      expect(draft.level).toBe('info');
      expect(draft.priority).toBe(100);
      expect(draft.isEnabled).toBe(true);
      expect(draft.excludeCompletedOrders).toBe(false);
      expect(draft.allowedFromOrderStatusIdsText).toBe('');
      expect(draft.excludeOrderStatusIdsText).toBe('');
      expect(draft.resolvers).toEqual([]);
      expect(draft.roleCodesText).toBe('');
      expect(draft.userIdsText).toBe('');
      expect(draft.titleTemplate).toBe('');
      expect(draft.messageTemplate).toBe('');
    });
  });

  describe('canManageNotificationRules', () => {
    it('checks the notifications.manage_rules permission', () => {
      expect(canManageNotificationRules({ permissions: ['notifications.manage_rules'] })).toBe(true);
      expect(canManageNotificationRules({ permissions: ['orders.view'] })).toBe(false);
      expect(canManageNotificationRules(undefined)).toBe(false);
      expect(canManageNotificationRules(null)).toBe(false);
    });
  });

  describe('canViewNotificationRules', () => {
    it('checks the notifications.view_rules permission', () => {
      expect(canViewNotificationRules({ permissions: ['notifications.view_rules'] })).toBe(true);
      expect(canViewNotificationRules({ permissions: ['orders.view'] })).toBe(false);
      expect(canViewNotificationRules(undefined)).toBe(false);
    });
  });
});
