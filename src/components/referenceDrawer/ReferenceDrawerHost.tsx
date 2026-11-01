// Боковая панель записи справочника (NewLine, мокап 14): «Изменить» и «Добавить» открывают форму справочника
// справа над списком; Esc, крестик и «Отмена» закрывают; после сохранения панель закрывается, список
// перечитывается (refine). Формы — те же компоненты страниц, см. REFERENCE_DRAWER_FORMS.
import React, { Suspense, useCallback, useMemo, useState } from 'react';
import { Drawer, Spin } from 'antd';
import {
  ReferenceDrawerFormProvider,
  ReferenceDrawerOpenerContext,
  type ReferenceDrawerAction,
} from './ReferenceDrawerContext';
import { REFERENCE_DRAWER_FORMS } from './referenceDrawerForms';
import { authSession } from '../../api/authSession';
import { canMutateHasuraResource } from '../../utils/resourcePermissions';
import './referenceDrawer.css';

interface OpenRecord {
  action: ReferenceDrawerAction;
  id?: string | number;
  /** новое открытие — свежая форма */
  seq: number;
}

export const ReferenceDrawerHost: React.FC<{
  resource: string | undefined;
  /** Название справочника — в заголовке панели. */
  title?: React.ReactNode;
  enabled: boolean;
  children: React.ReactNode;
}> = ({ resource, title, enabled, children }) => {
  const forms = enabled && resource ? REFERENCE_DRAWER_FORMS[resource] : undefined;
  const [current, setCurrent] = useState<OpenRecord | null>(null);
  const close = useCallback(() => setCurrent(null), []);
  // панель — только с правом записи (update для «Изменить», insert для «Добавить»); без него кнопки ведут на
  // страницы, как раньше
  const canOpen = useCallback((action: ReferenceDrawerAction) => (
    Boolean(resource) && canMutateHasuraResource(resource as string, authSession.getUser(), action === 'edit' ? 'update' : 'insert')
  ), [resource]);
  const opener = useMemo(() => (forms ? {
    canOpen,
    open: (action: ReferenceDrawerAction, id?: string | number) => {
      if (!canOpen(action)) return;
      setCurrent((prev) => ({ action, id, seq: (prev?.seq ?? 0) + 1 }));
    },
  } : null), [canOpen, forms]);

  if (!forms || !resource) return <>{children}</>;
  const Form = current ? forms[current.action] : null;
  return (
    <ReferenceDrawerOpenerContext.Provider value={opener}>
      {children}
      <Drawer
        rootClassName="wb-ref-drawer"
        open={Boolean(current)}
        onClose={close}
        width={480}
        destroyOnClose
        title={(
          <span className="wb-ref-drawer__title">
            <span>{current?.action === 'create' ? 'Новая запись' : 'Изменить запись'}</span>
            {title ? <small>{title}</small> : null}
          </span>
        )}
      >
        {current && Form ? (
          <ReferenceDrawerFormProvider
            key={current.seq}
            value={{ resource, action: current.action, id: current.id, onSaved: close }}
          >
            <Suspense fallback={<Spin />}>
              <Form />
            </Suspense>
          </ReferenceDrawerFormProvider>
        ) : null}
      </Drawer>
    </ReferenceDrawerOpenerContext.Provider>
  );
};
