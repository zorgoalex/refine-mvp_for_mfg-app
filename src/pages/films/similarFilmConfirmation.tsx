import { Modal, Space, Typography } from 'antd';
import { filmCatalogImportApi } from '../../api/filmCatalogImportApi';

export async function confirmSimilarFilmCreation(name: string, vendorId: number, canViewSimilar: boolean): Promise<boolean> {
  if (!canViewSimilar) return true;
  let similar;
  try {
    similar = (await filmCatalogImportApi.similar(name, vendorId)).items;
  } catch {
    return true;
  }
  if (similar.length === 0) return true;
  return new Promise((resolve) => {
    Modal.confirm({
      title: 'Найдены похожие плёнки',
      content: <Space direction="vertical">{similar.map((film) => <Typography.Text key={film.filmId}>{film.filmName}{film.vendorName ? ` · ${film.vendorName}` : ''}</Typography.Text>)}</Space>,
      okText: 'Всё равно создать', cancelText: 'Отмена', onOk: () => resolve(true), onCancel: () => resolve(false),
    });
  });
}
