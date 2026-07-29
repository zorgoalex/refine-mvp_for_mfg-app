import { useCallback, useRef, useState } from 'react';
import { notification } from 'antd';
import { profileApi } from '../api/profileApi';
import { authStorage } from '../utils/auth';
import { getLoadedRuntimeConfig } from '../config/runtimeConfig';
import { hasAnyDirty, useTabStore } from '../stores/tabStore';
import { useUiVariant } from './UiVariantProvider';
import { isModernUiAvailable, isModernUiVariant, isUiVariant, type UiVariant } from './uiVariant';
import { setStoredUiVariant } from './uiVariantStorage';

export type UiVariantSwitchBlockReason =
  | 'same'
  | 'saving'
  | 'unavailable'
  | 'dirty'
  | 'unauthenticated'
  | null;

interface UiVariantSwitchGuardInput {
  current: UiVariant;
  requested: UiVariant;
  isSaving: boolean;
  modernUiAvailable: boolean;
  hasDirtyTabs: boolean;
  userId: string | null;
  hasAccessToken: boolean;
}

interface PersistUiVariantDependencies {
  updatePreferences: (request: { uiVariant: UiVariant }) => Promise<unknown>;
  getCurrentUserId: () => string | null;
  setCached: (userId: string, variant: UiVariant) => void;
  reload: () => void;
}

interface UiVariantSwitchLock {
  current: boolean;
}

export function useUiVariantPreference() {
  const { variant } = useUiVariant();
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const modernUiAvailable = isModernUiAvailable(getLoadedRuntimeConfig()?.ui);

  const setVariant = useCallback(async (requested: UiVariant) => {
    const userId = getCurrentUserId();
    const blockReason = getUiVariantSwitchBlockReason({
      current: variant,
      requested,
      isSaving: savingRef.current,
      modernUiAvailable,
      hasDirtyTabs: hasAnyDirty(useTabStore.getState().tabs),
      userId,
      hasAccessToken: Boolean(authStorage.getAccessToken()),
    });

    if (blockReason === 'same' || blockReason === 'saving') return;

    if (blockReason === 'unavailable') {
      notification.warning({
        message: 'Дизайн временно недоступен',
        description: 'Администратор отключил новые варианты для безопасного обновления.',
      });
      return;
    }

    if (blockReason === 'dirty') {
      notification.warning({
        message: 'Есть несохранённые изменения',
        description: 'Сохраните или отмените изменения во вкладках, затем переключите дизайн.',
      });
      return;
    }

    if (blockReason === 'unauthenticated' || !userId) {
      notification.error({
        message: 'Не удалось сохранить дизайн',
        description: 'Сессия пользователя не найдена. Войдите снова.',
      });
      return;
    }

    if (!acquireUiVariantSwitchLock(savingRef)) return;
    setIsSaving(true);
    try {
      await persistUiVariantPreference(requested, userId, {
        updatePreferences: (request) => profileApi.updatePreferences(request),
        getCurrentUserId,
        setCached: setStoredUiVariant,
        reload: () => window.location.reload(),
      });
    } catch {
      if (getCurrentUserId() === userId) {
        notification.error({
          message: 'Не удалось сохранить дизайн',
          description: 'Выбор не изменён. Попробуйте ещё раз.',
        });
      }
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  }, [modernUiAvailable, variant]);

  return {
    variant,
    modernUiAvailable,
    isSaving,
    setVariant,
  };
}

export function acquireUiVariantSwitchLock(lock: UiVariantSwitchLock): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function getUiVariantSwitchBlockReason(
  input: UiVariantSwitchGuardInput,
): UiVariantSwitchBlockReason {
  if (input.requested === input.current) return 'same';
  if (input.isSaving) return 'saving';
  if (isModernUiVariant(input.requested) && !input.modernUiAvailable) return 'unavailable';
  if (input.hasDirtyTabs) return 'dirty';
  if (!input.hasAccessToken || !input.userId) return 'unauthenticated';
  return null;
}

export async function persistUiVariantPreference(
  requested: UiVariant,
  userId: string,
  dependencies: PersistUiVariantDependencies,
): Promise<'switched' | 'stale-user'> {
  const response = await dependencies.updatePreferences({ uiVariant: requested });
  if (dependencies.getCurrentUserId() !== userId) return 'stale-user';

  const confirmed = requireConfirmedUiVariant(response, requested);
  dependencies.setCached(userId, confirmed);
  dependencies.reload();
  return 'switched';
}

export function requireConfirmedUiVariant(
  response: unknown,
  requested: UiVariant,
): UiVariant {
  const confirmed = (
    response as { preferences?: { uiVariant?: unknown } } | null
  )?.preferences?.uiVariant;
  if (!isUiVariant(confirmed) || confirmed !== requested) {
    throw new Error('Backend did not confirm the requested UI variant');
  }
  return confirmed;
}

function getCurrentUserId(): string | null {
  const id = authStorage.getUser()?.id;
  return id === undefined || id === null ? null : String(id);
}
