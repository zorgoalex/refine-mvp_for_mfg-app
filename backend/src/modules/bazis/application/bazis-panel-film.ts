// Выбор плёнки панели Базиса — общий для парсера XML (материалы для сопоставления),
// сборки ERP-заказа и дерева узлов. Работает и на элементе XML, и на сохранённом raw_json.
//
// Два формата выгрузки:
// - штатный экспорт Базиса (Версия="2022.12.21.36090"): «Пласть/Наименование» — только
//   название плёнки, плёнка в свойствах — «Пленка»;
// - «Экспорт фасадов»: в «Пласть/Наименование» после перевода строки идёт поставщик
//   («Название⏎Поставщик»), появилось свойство «Пленка (обр)».
// Название с поставщиком приводится к виду справочника плёнок ERP: «Название; Поставщик».
// В штатном экспорте переводов строк в названиях нет, поэтому для него всё как раньше.

type RawElement = Record<string, unknown>;

export interface BazisFaceFilm {
  /** Название для ERP: «Название» или «Название; Поставщик». */
  name: string;
  /** Только название плёнки (первая строка). */
  filmPart: string;
  /** В исходном названии был поставщик (отдельной строкой). */
  withVendor: boolean;
}

const FILM_PROPERTY_NAMES = new Set(['пленка']);
/** Свойство панели с фрезеровкой: в XML встречаются оба написания. */
export const BAZIS_MILLING_PROPERTY_NAMES: ReadonlySet<string> = new Set(['фрезировка', 'фрезеровка']);
const BACK_FILM_PROPERTY_NAMES = new Set(['пленка (обр)']);
const MODEL_FILE_EXTENSION = /\.b3d$/i;

export function normalizeBazisReferenceName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

/** «Радиусная вытяжка.b3d» → «Радиусная вытяжка» (имя файла модели в «Экспорте фасадов»). */
export function stripBazisModelFileExtension(value: string | null): string | null {
  if (value == null) {
    return null;
  }
  const stripped = value.trim().replace(MODEL_FILE_EXTENSION, '').trim();
  return stripped.length > 0 ? stripped : value.trim() || null;
}

/** Название плёнки с пласти: строки (название, поставщик) склеиваются через «; ». */
export function parseBazisFaceFilmName(value: unknown): BazisFaceFilm | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const lines = String(value)
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }
  return {
    name: lines.join('; '),
    filmPart: lines[0],
    withVendor: lines.length > 1,
  };
}

export function bazisUserPropertyValue(
  rawJson: RawElement | null,
  acceptedNames: ReadonlySet<string>,
): string | null {
  if (!rawJson) {
    return null;
  }

  const propertyCandidates: unknown[] = [];
  const nested = rawJson['ПользовательскиеСвойства'];
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    propertyCandidates.push((nested as RawElement)['Свойство']);
  }
  propertyCandidates.push(rawJson['Свойство']);

  for (const candidate of propertyCandidates) {
    const properties = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    for (const property of properties) {
      if (typeof property !== 'object' || property === null || Array.isArray(property)) {
        continue;
      }
      const row = property as RawElement;
      const propertyName = textValue(row['Имя'] ?? row['Наименование']);
      if (!propertyName || !acceptedNames.has(normalizeBazisReferenceName(propertyName))) {
        continue;
      }
      const propertyValue = textValue(row['Значение']);
      if (propertyValue) {
        return propertyValue;
      }
    }
  }

  return null;
}

/** Плёнки обеих пластей панели в порядке ОблицовкаПласти1, ОблицовкаПласти2. */
export function bazisFaceFilms(rawJson: RawElement | null): BazisFaceFilm[] {
  if (!rawJson) {
    return [];
  }
  const result: BazisFaceFilm[] = [];
  for (const faceKey of ['ОблицовкаПласти1', 'ОблицовкаПласти2']) {
    const face = rawJson[faceKey];
    if (typeof face !== 'object' || face === null) {
      continue;
    }
    const plasti = (face as RawElement)['Пласть'];
    const list = Array.isArray(plasti) ? plasti : plasti ? [plasti] : [];
    for (const plast of list) {
      if (typeof plast !== 'object' || plast === null) {
        continue;
      }
      const film = parseBazisFaceFilmName((plast as RawElement)['Наименование']);
      if (film) {
        result.push(film);
      }
    }
  }
  return result;
}

/**
 * Плёнка из пользовательских свойств: «Пленка», иначе «Пленка (обр)».
 * Поставщик, записанный в свойство отдельной строкой, приводится к «Название; Поставщик».
 * Если на пласти та же плёнка с поставщиком — берётся вариант с поставщиком
 * («Название; Поставщик»): он однозначно находит плёнку в справочнике ERP.
 */
export function bazisPanelPropertyFilmName(rawJson: RawElement | null): string | null {
  const propertyFilm =
    bazisUserPropertyValue(rawJson, FILM_PROPERTY_NAMES) ??
    bazisUserPropertyValue(rawJson, BACK_FILM_PROPERTY_NAMES);
  // «Экспорт фасадов» может записать поставщика и в само свойство («Название⏎Поставщик»).
  const property = parseBazisFaceFilmName(propertyFilm);
  if (!property) {
    return null;
  }
  if (property.withVendor) {
    return property.name;
  }
  const wanted = normalizeBazisReferenceName(property.filmPart);
  const withVendor = bazisFaceFilms(rawJson).find(
    (film) => film.withVendor && normalizeBazisReferenceName(film.filmPart) === wanted,
  );
  return withVendor ? withVendor.name : propertyFilm;
}

/**
 * Имя плёнки по правилу до «Экспорта фасадов» (до 2026-11-18): свойство «Пленка» как есть,
 * иначе единственное название пласти как есть (с переводом строки, если он был).
 * Нужно, чтобы сохранённые ранее сопоставления плёнок (в т.ч. «Пропустить») продолжали
 * действовать после перехода на «Название; Поставщик». Для штатного экспорта совпадает с
 * новым именем.
 */
export function bazisPanelLegacyFilmName(rawJson: RawElement | null): string | null {
  const property = bazisUserPropertyValue(rawJson, FILM_PROPERTY_NAMES);
  if (property) {
    return property;
  }
  const unique = new Map<string, string>();
  for (const face of rawFaceNames(rawJson)) {
    unique.set(normalizeBazisReferenceName(face), face);
  }
  return unique.size === 1 ? [...unique.values()][0] ?? null : null;
}

/** Единственная (без учёта регистра) плёнка пластей, иначе null. */
export function bazisPanelUniqueFaceFilm(rawJson: RawElement | null): BazisFaceFilm | null {
  const unique = new Map<string, BazisFaceFilm>();
  for (const film of bazisFaceFilms(rawJson)) {
    unique.set(normalizeBazisReferenceName(film.name), film);
  }
  return unique.size === 1 ? [...unique.values()][0] ?? null : null;
}

function rawFaceNames(rawJson: RawElement | null): string[] {
  if (!rawJson) {
    return [];
  }
  const result: string[] = [];
  for (const faceKey of ['ОблицовкаПласти1', 'ОблицовкаПласти2']) {
    const face = rawJson[faceKey];
    if (typeof face !== 'object' || face === null) {
      continue;
    }
    const plasti = (face as RawElement)['Пласть'];
    const list = Array.isArray(plasti) ? plasti : plasti ? [plasti] : [];
    for (const plast of list) {
      if (typeof plast !== 'object' || plast === null) {
        continue;
      }
      const value = (plast as RawElement)['Наименование'];
      if (typeof value === 'string' && value.trim().length > 0) {
        result.push(value.trim());
      }
    }
  }
  return result;
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}
