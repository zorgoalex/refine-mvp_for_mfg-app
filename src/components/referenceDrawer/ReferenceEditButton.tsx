// Кнопка «Изменить» в строке справочника: в NewLine (если форма справочника открывается в панели) — панель
// справа, иначе — прежний переход на страницу редактирования. Это та же кнопка refine (её проверка прав
// accessControl сохраняется), только щелчок открывает панель вместо перехода.
import React from 'react';
import { EditButton } from '@refinedev/antd';
import { useReferenceDrawerOpener } from './ReferenceDrawerContext';

type EditButtonProps = React.ComponentProps<typeof EditButton>;

export const ReferenceEditButton: React.FC<EditButtonProps> = (props) => {
  const opener = useReferenceDrawerOpener();
  if (!opener || !opener.canOpen('edit') || props.recordItemId == null) return <EditButton {...props} />;
  return (
    <EditButton
      {...props}
      onClick={(event) => {
        event.stopPropagation();
        opener.open('edit', props.recordItemId as string | number);
      }}
    />
  );
};
