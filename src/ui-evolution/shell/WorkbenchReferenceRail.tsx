import React from 'react';
import { MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { buildReferenceRail, filterReferenceRail, findReferenceByPath } from '../../utils/referenceCatalog';
import { useEvolutionNavigation } from './useEvolutionNavigation';

const RAIL_HIDDEN_KEY = 'erp.references.railHidden';

const readHidden = (): boolean => {
  try {
    return window.localStorage.getItem(RAIL_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
};

/**
 * «NewLine»: левая панель «все справочники» на экранах-списках справочников — переход между ними
 * без бокового меню. Состав — из того же меню с учётом прав; на остальных экранах панели нет.
 */
export const WorkbenchReferenceRail: React.FC = () => {
  const { sider } = useEvolutionNavigation();
  const { pathname } = useLocation();
  const [query, setQuery] = React.useState('');
  const [hidden, setHidden] = React.useState(readHidden);

  const groups = React.useMemo(() => buildReferenceRail(sider.categorizedResources), [sider.categorizedResources]);
  const current = React.useMemo(() => findReferenceByPath(groups, pathname), [groups, pathname]);
  const shown = React.useMemo(() => filterReferenceRail(groups, query), [groups, query]);

  if (!current) return null;

  const toggleHidden = () => {
    setHidden((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(RAIL_HIDDEN_KEY, next ? '1' : '0');
      } catch {
        // панель просто не запомнит выбор
      }
      return next;
    });
  };

  if (hidden) {
    return (
      <nav className="wb-refs-rail wb-refs-rail--hidden" aria-label="Справочники">
        <button type="button" className="wb-refs-rail__toggle" aria-label="Показать список справочников" title="Все справочники" onClick={toggleHidden}>
          <MenuUnfoldOutlined aria-hidden />
        </button>
      </nav>
    );
  }

  return (
    <nav className="wb-refs-rail" aria-label="Справочники">
      <div className="wb-refs-rail__head">
        <label className="wb-refs-rail__search">
          <SearchOutlined aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Найти справочник"
            aria-label="Поиск по справочникам"
            autoComplete="off"
          />
        </label>
        <button type="button" className="wb-refs-rail__toggle" aria-label="Скрыть список справочников" title="Скрыть список" onClick={toggleHidden}>
          <MenuFoldOutlined aria-hidden />
        </button>
      </div>
      <div className="wb-refs-rail__scroll">
        {shown.length === 0 ? <div className="wb-refs-rail__none">Ничего не найдено</div> : null}
        {shown.map((group) => (
          <div className="wb-refs-rail__group" key={group.label}>
            <div className="wb-refs-rail__group-label">{group.label}</div>
            {group.items.map((item) => (
              <button
                type="button"
                key={item.name}
                className="wb-refs-rail__item"
                aria-current={item.name === current.name ? 'true' : undefined}
                title={item.label}
                onClick={() => sider.handleNavigate(item.route)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
};

export default WorkbenchReferenceRail;
