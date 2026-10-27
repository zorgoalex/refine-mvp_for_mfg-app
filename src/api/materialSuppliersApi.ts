import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';

/** Поставщик в списке позиции материала (migr 280). */
export interface MaterialSupplierRef {
  id: number;
  name: string;
  isActive: boolean;
}

export interface FilmSuppliersDto {
  filmId: number;
  /** Выбранные, по порядку: первый — основной. */
  suppliers: MaterialSupplierRef[];
  /** По приходам 1С — только для просмотра. */
  onecSuppliers: Array<{ key: string; name: string }>;
}

export const materialSuppliersApi = {
  /** Поставщики плёнок (не больше 500 id за раз). */
  films(filmIds: number[]) {
    return httpClient.get<FilmSuppliersDto[]>(withQuery(backendApiPath('/films/suppliers'), { ids: filmIds.join(',') }));
  },
  /** Заменить выбранных поставщиков плёнки; expectedSupplierIds — список, который видел пользователь (иначе 409). */
  replaceFilm(filmId: number, supplierIds: number[], expectedSupplierIds: number[]) {
    return httpClient.put<FilmSuppliersDto>(backendApiPath(`/films/${filmId}/suppliers`), { supplierIds, expectedSupplierIds });
  },
};
