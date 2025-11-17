import React from 'react';
import { List } from '@refinedev/antd';
import { CalendarOutlined } from '@ant-design/icons';
import CalendarBoard from './components/CalendarBoard';
import './styles/calendar.css';

/**
 * Главная страница производственного календаря
 */
export const CalendarList: React.FC = () => {
  return (
    <List
      title="Производственный календарь"
      headerProps={{
        extra: null, // Пока без дополнительных кнопок
      }}
      breadcrumb={null}
    >
      <div className="calendar-page">
        <CalendarBoard />
      </div>
    </List>
  );
};

export default CalendarList;
