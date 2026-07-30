import React, { useEffect, useState } from 'react';
import { Badge, Button, Switch } from 'antd';
import { FilterOutlined, PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import CalendarBoard from './components/CalendarBoard';
import { OperationalPageHeader, useOperationalUi } from '../../ui-operational/OperationalPrimitives';
import './styles/calendar.css';
import './styles/calendar-mobile.css';

/**
 * Главная страница производственного календаря
 * Без List wrapper для полного контроля над layout
 */
export const CalendarList: React.FC = () => {
  const isOperational = useOperationalUi();
  const navigate = useNavigate();
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Убираем скролл у родительского контейнера при монтировании
  useEffect(() => {
    const content = document.querySelector('.ant-layout-content');
    if (content) {
      content.classList.add('calendar-page-active');
    }
    return () => {
      if (content) {
        content.classList.remove('calendar-page-active');
      }
    };
  }, []);

  return (
    <div className="calendar-page-wrapper">
      {isOperational ? (
        <OperationalPageHeader
          compact
          breadcrumbs="Производство / Планирование / Календарь"
          title="Производственный календарь"
          description="Нагрузка по дням, сроки заказов и риски производства на одной временной шкале."
          actions={(
            <>
              <Badge count={3} size="small" offset={[-4, 5]}>
                <Button
                  icon={<FilterOutlined />}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  Фильтры
                </Button>
              </Badge>
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => navigate('/orders/create')}
              >
                Запланировать заказ
              </Button>
            </>
          )}
        />
      ) : (
        <h2 style={{ margin: '16px 24px 0', fontSize: '20px', fontWeight: 500 }}>
          Производственный календарь
        </h2>
      )}
      {isOperational && filtersOpen ? (
        <div className="calendar-filter-summary" aria-label="Фильтры календаря">
          <label><Switch size="small" defaultChecked /> С активными производственными этапами</label>
          <label><Switch size="small" defaultChecked /> Показывать риски сроков</label>
          <label><Switch size="small" defaultChecked /> Только открытые заказы</label>
        </div>
      ) : null}
      <div className="calendar-page">
        <CalendarBoard />
      </div>
    </div>
  );
};

export default CalendarList;
