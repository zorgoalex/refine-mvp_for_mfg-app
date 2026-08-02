import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button } from 'antd';
import { FilterOutlined, PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import CalendarBoard from './components/CalendarBoard';
import type { CalendarFilters } from './types/calendar';
import { getCalendarActiveFilterCount } from './utils/calendarFilters';
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
  const [filters, setFilters] = useState<CalendarFilters>({});
  const activeFilterCount = useMemo(() => getCalendarActiveFilterCount(filters), [filters]);
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
              <Badge count={activeFilterCount} size="small" offset={[-4, 5]}>
                <Button
                  type={filtersOpen || activeFilterCount > 0 ? 'primary' : 'default'}
                  icon={<FilterOutlined />}
                  aria-expanded={filtersOpen}
                  onClick={() => setFiltersOpen((open) => !open)}
                >
                  {filtersOpen ? 'Скрыть фильтры' : activeFilterCount > 0 ? 'Фильтры активны' : 'Фильтры'}
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
        <div className="calendar-page-header">
          <h2>Производственный календарь</h2>
          <div className="calendar-page-header__actions">
            <Badge count={activeFilterCount} size="small" offset={[-4, 5]}>
              <Button
                type={filtersOpen || activeFilterCount > 0 ? 'primary' : 'default'}
                icon={<FilterOutlined />}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {filtersOpen ? 'Скрыть фильтры' : activeFilterCount > 0 ? 'Фильтры активны' : 'Фильтры'}
              </Button>
            </Badge>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => navigate('/orders/create')}
            >
              Запланировать заказ
            </Button>
          </div>
        </div>
      )}
      <div className="calendar-page">
        <CalendarBoard
          filters={filters}
          filtersOpen={filtersOpen}
          onFiltersChange={setFilters}
        />
      </div>
    </div>
  );
};

export default CalendarList;
