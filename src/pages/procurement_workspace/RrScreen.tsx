import { ConfigProvider, theme } from 'antd';
import type { CSSProperties, ReactNode } from 'react';
import './procurementWorkspace.css';
import { rrThemeVars } from './rrTheme';

/** Компактные элементы, как в мокапе: поля и кнопки 32 px, таблица 9/10 px. Цвета — от темы. */
const RR_SIZE_THEME = {
  token: { controlHeight: 32, controlHeightSM: 26, controlHeightLG: 36 },
  components: {
    Button: { controlHeight: 32, fontWeight: 400 },
    Table: { cellPaddingBlock: 9, cellPaddingInline: 10, cellPaddingBlockSM: 9, cellPaddingInlineSM: 10 },
  },
};

/** Обёртка экрана «Потребности заказов в ресурсах» в стиле мокапа. */
export function RrScreen({ children, className }: { children: ReactNode; className?: string }) {
  const { token } = theme.useToken();
  return (
    <ConfigProvider theme={RR_SIZE_THEME}>
      <div className={['rr-screen', className].filter(Boolean).join(' ')} style={rrThemeVars(token) as CSSProperties}>
        {children}
      </div>
    </ConfigProvider>
  );
}
