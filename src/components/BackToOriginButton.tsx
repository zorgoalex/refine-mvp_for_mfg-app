// «← Заказ 3087»: карточка открыта ссылкой из другой записи (см. utils/backToOrigin) — кнопка возвращает туда же.
// Открыта иначе — кнопки нет.
import React from 'react';
import { Button } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useBackToOrigin } from '../utils/backToOrigin';

export const BackToOriginButton: React.FC<{ style?: React.CSSProperties }> = ({ style }) => {
  const { origin, goBack } = useBackToOrigin();
  if (!origin) return null;
  return (
    <Button className="app-back-to-origin" type="text" icon={<ArrowLeftOutlined />} onClick={goBack} title="Вернуться" style={style}>
      {origin.fromLabel ?? 'Назад'}
    </Button>
  );
};
