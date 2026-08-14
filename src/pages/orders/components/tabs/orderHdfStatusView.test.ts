import { describe, expect, it } from 'vitest';
import type { OrderHdfDetail } from '../../../../types/orders';
import {
  collectHdfConfigErrorDescriptions,
  describeHdfConfigErrors,
  HDF_CONFIG_SETTINGS_LOCATION,
} from './orderHdfStatusView';

describe('orderHdfStatusView', () => {
  it('explains missing HDF calculation settings', () => {
    expect(describeHdfConfigErrors(['missing_threshold', 'missing_hdf_sheet_material'])).toEqual([
      'не задана минимальная сторона ХДФ',
      'не выбран листовой материал ХДФ',
    ]);
    expect(HDF_CONFIG_SETTINGS_LOCATION).toContain('Пороги техпроцессов');
  });

  it('collects unique config errors only from config_missing HDF rows', () => {
    const rows = [
      hdfRow(1, 'config_missing', ['missing_hdf_sheet_material', 'missing_hdf_sheet_material']),
      hdfRow(2, 'ok', ['missing_threshold']),
      hdfRow(3, 'config_missing', ['missing_threshold']),
    ];

    expect(collectHdfConfigErrorDescriptions(rows)).toEqual([
      'не выбран листовой материал ХДФ',
      'не задана минимальная сторона ХДФ',
    ]);
  });
});

function hdfRow(id: number, status: string, configErrors: string[]): OrderHdfDetail {
  return {
    order_hdf_detail_id: id,
    source_order_detail_id_snapshot: 1,
    area_m2: 0,
    status,
    config_errors: configErrors,
    version: 1,
  };
}
