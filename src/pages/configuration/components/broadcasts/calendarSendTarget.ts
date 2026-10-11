import { useCallback, useEffect, useRef, useState } from 'react';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import { hasCalendarSendSettingsPermissions } from './calendarSendSupport';
import { loadWhatsAppGroups } from '../whatsappGroupsCache';
import { findGroupById, groupDisplayName } from '../whatsappGroupsView';

export const CALENDAR_SEND_LABEL = 'Отправить в чат';

/** What the calendar send goes to: no group yet, a group with a known name, or a group the list could not name. */
export type CalendarSendTarget =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'group'; name: string | null };

export function calendarSendTooltip(target: CalendarSendTarget): string {
  if (target.kind === 'none') return `${CALENDAR_SEND_LABEL}: группа не выбрана (Конфигурация → Рассылка сообщений)`;
  if (target.kind === 'group' && target.name) return `${CALENDAR_SEND_LABEL} «${target.name}»`;
  return CALENDAR_SEND_LABEL;
}

/** The settings of the calendar send (and the group list that names the chat) belong to the WhatsApp admin. */
export function canReadCalendarSendSettings(): boolean {
  return hasCalendarSendSettingsPermissions();
}

/**
 * A user who may only send (no whatsapp.manage) learns whether a group is chosen, not which one: the backend
 * gives that read neither the group id nor the caption.
 */
export async function loadCalendarSendTarget(withSettings = canReadCalendarSendSettings()): Promise<CalendarSendTarget> {
  if (!withSettings) {
    const { configured } = await broadcastsApi.calendarSendAvailability();
    return configured ? { kind: 'group', name: null } : { kind: 'none' };
  }
  const { settings } = await broadcastsApi.calendarSendSettings();
  const id = settings.groupChatId?.trim();
  if (!id) return { kind: 'none' };
  const group = await loadWhatsAppGroups().then((groups) => findGroupById(groups, id), () => undefined);
  return { kind: 'group', name: group ? groupDisplayName(group) : null };
}

/** Matches the group-list cache: a hover after a minute reads the current settings again. */
const TARGET_TTL_MS = 60_000;

/**
 * Tooltip text for the calendar «Отправить в чат» icon. Loaded once when the icon becomes
 * available and again on hover when older than a minute, so a group changed in the settings
 * shows up without a page reload. Failures keep the plain label.
 */
export function useCalendarSendTooltip(enabled: boolean): { title: string; refresh: () => void } {
  const [target, setTarget] = useState<CalendarSendTarget>({ kind: 'unknown' });
  const loadedAt = useRef(0);
  const loading = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(() => {
    if (!enabled || loading.current || Date.now() - loadedAt.current < TARGET_TTL_MS) return;
    loading.current = true;
    loadCalendarSendTarget().then(
      (next) => { loadedAt.current = Date.now(); if (mounted.current) setTarget(next); },
      () => undefined,
    ).finally(() => { loading.current = false; });
  }, [enabled]);

  useEffect(() => { refresh(); }, [refresh]);

  return { title: calendarSendTooltip(target), refresh };
}
