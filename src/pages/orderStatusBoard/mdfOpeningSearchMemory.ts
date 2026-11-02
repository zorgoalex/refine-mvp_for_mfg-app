/**
 * МДФ-доска: сохранять ли поиск по номерам заказов (`order=`) при следующем открытии.
 *
 * Каждое открытие доски начинается с сегодняшнего дня (так и было). Поиск по номерам при этом
 * сохраняется только при возврате к ещё открытой вкладке доски — тем же пользователем и в тот же
 * день (например, после заказа, открытого по номеру на карточке). Новое открытие очищает поиск:
 * - первое открытие (в том числе после скрытой предзагрузки доски — она не считается показом);
 * - вкладку доски закрыли;
 * - наступил новый день: день открытия запоминается при показе доски и сверяется при возврате
 *   (не только по таймеру — уход и возврат могут уложиться в секунды после полуночи);
 * - сменился пользователь (владелец поиска запоминается при показе доски).
 */
export interface MdfOpeningSearchMemory {
  /** доска показана (active) пользователем userId в день day; учитывается первый показ после скрытия */
  shown(userId: unknown, day: string): void;
  /** доска скрыта; учитывается только переход «показана → скрыта» */
  hidden(boardTabOpen: boolean): void;
  /** вкладку доски закрыли */
  tabClosed(): void;
  /** наступил новый день, сменился пользователь — следующее открытие новое */
  reset(): void;
  /** сохранять поиск при этом открытии */
  keepsSearch(userId: unknown, today: string): boolean;
}

interface ReturnTarget {
  userId: unknown;
  day: string;
}

export function createMdfOpeningSearchMemory(): MdfOpeningSearchMemory {
  // кто и с какого дня сейчас смотрит доску (undefined — доска не показана)
  let shownBy: ReturnTarget | undefined;
  // к чьей открытой вкладке и в какой день вернутся; null — новое открытие
  let returnTo: ReturnTarget | null = null;
  return {
    shown(userId, day) {
      if (!shownBy) shownBy = { userId: userId ?? null, day };
    },
    hidden(boardTabOpen) {
      if (!shownBy) return;
      returnTo = boardTabOpen ? shownBy : null;
      shownBy = undefined;
    },
    tabClosed() {
      returnTo = null;
    },
    reset() {
      returnTo = null;
      shownBy = undefined;
    },
    keepsSearch(userId, today) {
      return returnTo !== null && returnTo.userId === (userId ?? null) && returnTo.day === today;
    },
  };
}
