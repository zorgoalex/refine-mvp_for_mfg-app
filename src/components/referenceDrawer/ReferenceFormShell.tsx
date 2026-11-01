// Обёртки Edit/Create страниц справочников: на своей странице — refine Edit/Create как раньше; в боковой
// панели — та же карточка формы с кнопкой «Сохранить», но без шапки страницы, крошек и «назад».
import React from 'react';
import { Create, Edit } from '@refinedev/antd';
import { useReferenceDrawerForm } from './ReferenceDrawerContext';

type EditProps = React.ComponentProps<typeof Edit>;
type CreateProps = React.ComponentProps<typeof Create>;

export const ReferenceEdit: React.FC<EditProps> = (props) => {
  const drawer = useReferenceDrawerForm();
  if (!drawer) return <Edit {...props} />;
  return (
    <Edit
      {...props}
      resource={drawer.resource}
      recordItemId={drawer.id}
      breadcrumb={false}
      goBack={false}
      title={false}
      headerButtons={() => null}
      wrapperProps={{ ...props.wrapperProps, className: [props.wrapperProps?.className, 'wb-ref-drawer__form'].filter(Boolean).join(' ') }}
    />
  );
};

export const ReferenceCreate: React.FC<CreateProps> = (props) => {
  const drawer = useReferenceDrawerForm();
  if (!drawer) return <Create {...props} />;
  return (
    <Create
      {...props}
      resource={drawer.resource}
      breadcrumb={false}
      goBack={false}
      title={false}
      headerButtons={() => null}
      wrapperProps={{ ...props.wrapperProps, className: [props.wrapperProps?.className, 'wb-ref-drawer__form'].filter(Boolean).join(' ') }}
    />
  );
};
