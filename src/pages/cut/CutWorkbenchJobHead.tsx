// «NewLine» cut screen, the open job: title with status, the steps of the job and its tabs.
import React from 'react';
import { Button, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { CheckOutlined, MoreOutlined } from '@ant-design/icons';

export type CutJobStepState = 'done' | 'current' | 'todo' | 'error';

export interface CutJobStep {
  key: string;
  title: string;
  hint: string;
  state: CutJobStepState;
}

export interface CutJobTab {
  key: string;
  label: string;
  count?: number;
}

interface CutWorkbenchJobHeadProps {
  number: string;
  status: React.ReactNode;
  source: string;
  /** the job name with its existing inline editor */
  name: React.ReactNode;
  actions?: React.ReactNode;
  menuItems?: MenuProps['items'];
  steps: CutJobStep[];
  tabs: CutJobTab[];
  tab: string;
  onTabChange: (key: string) => void;
}

export const CutWorkbenchJobHead: React.FC<CutWorkbenchJobHeadProps> = ({
  number,
  status,
  source,
  name,
  actions,
  menuItems,
  steps,
  tabs,
  tab,
  onTabChange,
}) => (
  <div className="wb-cut-head">
    <div className="wb-cut-head__top">
      <h2 className="wb-cut-head__title">Задание {number}</h2>
      {status}
      <span className="wb-cut-head__source">{source}</span>
      <span className="wb-cut-head__grow" />
      {actions}
      {menuItems && menuItems.length > 0 ? (
        <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
          <Button icon={<MoreOutlined />} aria-label="Действия с заданием" />
        </Dropdown>
      ) : null}
    </div>
    <div className="wb-cut-head__name">{name}</div>
    <ol className="wb-cut-steps" aria-label="Ход задания">
      {steps.map((step, index) => (
        <li key={step.key} className="wb-cut-step" data-state={step.state}>
          <span className="wb-cut-step__mark" aria-hidden>
            {step.state === 'done' ? <CheckOutlined /> : index + 1}
          </span>
          <span className="wb-cut-step__text">
            <b>{step.title}</b>
            <small>{step.hint}</small>
          </span>
        </li>
      ))}
    </ol>
    <div className="wb-cut-tabs" role="tablist" aria-label="Разделы задания">
      {tabs.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          className="wb-cut-tabs__item"
          aria-selected={tab === item.key}
          onClick={() => onTabChange(item.key)}
        >
          {item.label}
          {item.count != null ? <small>{item.count}</small> : null}
        </button>
      ))}
    </div>
  </div>
);
