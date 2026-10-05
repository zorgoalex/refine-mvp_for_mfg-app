import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';

export interface FilmNameIndexItem {
  name: string;
  filmId: number;
  canonicalFilmId: number | null;
  vendorId: number | null;
  active: boolean;
  source: 'current' | 'history';
}

export interface FilmNameIndexResponse {
  items: FilmNameIndexItem[];
  /** Индекс обрезан лимитом ответа — неполный, для сопоставления не годится. */
  truncated: boolean;
}

export const filmNameIndexApi = {
  list() {
    return httpClient.get<FilmNameIndexResponse>(backendApiPath('/films/name-index'));
  },
};
