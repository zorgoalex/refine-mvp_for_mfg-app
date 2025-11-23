import React, { useEffect } from 'react';
import CalendarBoard from './components/CalendarBoard';
import './styles/calendar.css';

/**
 * Главная страница производственного календаря
 * Без List wrapper для полного контроля над layout
 */
export const CalendarList: React.FC = () => {
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
      <h2 style={{ margin: '16px 24px 0', fontSize: '20px', fontWeight: 500 }}>
        Производственный календарь
      </h2>
      <div className="calendar-page">
        <CalendarBoard />
      </div>
    </div>
  );
};

export default CalendarList;
