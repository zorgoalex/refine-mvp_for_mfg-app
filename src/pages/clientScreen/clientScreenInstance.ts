import { useSyncExternalStore } from 'react';
import { clientScreenSettingsApi } from '../../api/clientScreenSettingsApi';
import { featureFlags } from '../../config/featureFlags';
import { browserClientScreenEnvironment } from './clientScreenEnvironment';
import { ClientScreenPresenter, type ClientScreenPresenterView } from './clientScreenPresenter';
import { openClientScreenWindow } from './openClientScreenWindow';

/**
 * The one presenter of this app window, created on first use. When the customer screen is switched
 * off for the deployment, or the browser lacks what it needs, there is no presenter and the order
 * form works exactly as without the feature.
 */
let presenter: ClientScreenPresenter | null | undefined;

export function getClientScreenPresenter(): ClientScreenPresenter | null {
  if (presenter !== undefined) return presenter;
  presenter = null;
  if (!featureFlags.clientScreen) return presenter;
  try {
    presenter = new ClientScreenPresenter({
      env: browserClientScreenEnvironment(),
      loadPolicy: async () => {
        const settings = await clientScreenSettingsApi.get();
        return { enabled: settings.enabled, visibleCodes: settings.visibleCodes, version: settings.version };
      },
      openWindow: () => { void openClientScreenWindow().catch(() => undefined); },
    });
  } catch {
    presenter = null;
  }
  return presenter;
}

const NO_VIEW: ClientScreenPresenterView = { phase: 'idle', presentedOrderKey: null, lost: null, workstationDisabled: false, policyStale: false };
const noSubscribe = () => () => undefined;
const noView = () => NO_VIEW;

/** State of the customer screen for the order header; `available` is false when the feature is off. */
export function useClientScreenView(): ClientScreenPresenterView & { available: boolean } {
  const instance = getClientScreenPresenter();
  const view = useSyncExternalStore(instance ? instance.subscribe : noSubscribe, instance ? instance.getView : noView);
  return { ...view, available: instance !== null };
}
