import React from 'react';
import { MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router-dom';
import { buildReferenceRail, filterReferenceRail, findReferenceByPath, isReferenceRailHidden, isWideReference } from '../../utils/referenceCatalog';
import { useEvolutionNavigation } from './useEvolutionNavigation';

const RAIL_HIDDEN_KEY = 'erp.references.railHidden';

type RailKind = 'wide' | 'regular';
type RailChoices = Record<RailKind, boolean | null>;
const storageKey = (kind: RailKind) => (kind === 'wide' ? `${RAIL_HIDDEN_KEY}.wide` : RAIL_HIDDEN_KEY);

/** Явный выбор пользователя в этом браузере; `null` — не выбирал. */
const readChoice = (kind: RailKind): boolean | null => {
  try {
    const stored = window.localStorage.getItem(storageKey(kind));
    return stored === '1' ? true : stored === '0' ? false : null;
  } catch {
    return null;
  }
};
const readChoices = (): RailChoices => ({ wide: readChoice('wide'), regular: readChoice('regular') });

/**
 * «NewLine»: левая панель «все справочники» на экранах-списках справочников — переход между ними
 * без бокового меню. Состав — из того же меню с учётом прав; на остальных экранах панели нет.
 */
export const WorkbenchReferenceRail: React.FC = () => {
  const { sider } = useEvolutionNavigation();
  const { pathname } = useLocation();
  const [query, setQuery] = React.useState('');
  const [choices, setChoices] = React.useState(readChoices);

  const groups = React.useMemo(() => buildReferenceRail(sider.categorizedResources), [sider.categorizedResources]);
  const current = React.useMemo(() => findReferenceByPath(groups, pathname), [groups, pathname]);
  const shown = React.useMemo(() => filterReferenceRail(groups, query), [groups, query]);

  if (!current) return null;

  const kind: RailKind = isWideReference(current.name) ? 'wide' : 'regular';
  const hidden = isReferenceRailHidden(choices[kind], current.name, window.innerWidth);
  const toggleHidden = () => {
    const next = !hidden;
    try {
      window.localStorage.setItem(storageKey(kind), next ? '1' : '0');
    } catch {
      // панель просто не запомнит выбор
    }
    setChoices((value) => ({ ...value, [kind]: next }));
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
