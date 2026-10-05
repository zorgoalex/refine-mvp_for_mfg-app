import type { ClientScreenPresenterView } from './clientScreenPresenter';

/**
 * What the order header shows for the customer screen, as plain data. The emergency switch-off is
 * not here: it is in the app header of every tab while something is presented.
 */
export type ClientScreenControlModel =
  | { mode: 'workstation-off' }
  | { mode: 'presenting'; waiting: boolean }
  | { mode: 'idle'; label: 'Показать клиенту' | 'Показать этот заказ'; canPresent: boolean; hint: string };

export function clientScreenControlModel(view: ClientScreenPresenterView, orderKey: string, referencesReady: boolean): ClientScreenControlModel {
  if (view.workstationDisabled) return { mode: 'workstation-off' };
  if (view.presentedOrderKey === orderKey) return { mode: 'presenting', waiting: view.phase !== 'owner' || view.policyStale };
  const other = view.presentedOrderKey !== null;
  return {
    mode: 'idle',
    label: other ? 'Показать этот заказ' : 'Показать клиенту',
    // Without the form's reference names the customer would see dashes instead of names: not offered.
    canPresent: referencesReady,
    hint: !referencesReady
      ? 'Экран клиента недоступен: справочники формы ещё не загружены'
      : other ? 'Сейчас клиенту показан другой заказ. Нажмите, чтобы показать этот' : 'Показать этот заказ на экране клиента',
  };
}
