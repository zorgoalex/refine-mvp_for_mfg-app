// «NewLine», справочники (мокап 14): запись правится и добавляется в боковой панели над списком, а не на
// отдельной странице. Форма в панели — та же форма страницы справочника: она берёт из этого контекста ресурс,
// запись и действие вместо адреса, а после сохранения панель закрывается и список перечитывается сам (refine).
import React, { createContext, useContext } from 'react';

export type ReferenceDrawerAction = 'edit' | 'create';

export interface ReferenceDrawerForm {
  resource: string;
  action: ReferenceDrawerAction;
  id?: string | number;
  /** Сохранено: закрыть панель. */
  onSaved: () => void;
}

/** Форма открыта в боковой панели (иначе — на своей странице, как раньше). */
export const ReferenceDrawerFormContext = createContext<ReferenceDrawerForm | null>(null);

export const useReferenceDrawerForm = (): ReferenceDrawerForm | null => useContext(ReferenceDrawerFormContext);

/** Список справочника умеет открывать запись в боковой панели (NewLine и форма справочника известна). */
export interface ReferenceDrawerOpener {
  /** Есть ли у пользователя право записи для этого действия (те же правила, что у Hasura). */
  canOpen: (action: ReferenceDrawerAction) => boolean;
  open: (action: ReferenceDrawerAction, id?: string | number) => void;
}

export const ReferenceDrawerOpenerContext = createContext<ReferenceDrawerOpener | null>(null);

export const useReferenceDrawerOpener = (): ReferenceDrawerOpener | null => useContext(ReferenceDrawerOpenerContext);

export const ReferenceDrawerFormProvider: React.FC<{ value: ReferenceDrawerForm; children: React.ReactNode }> = ({ value, children }) => (
  <ReferenceDrawerFormContext.Provider value={value}>{children}</ReferenceDrawerFormContext.Provider>
);
