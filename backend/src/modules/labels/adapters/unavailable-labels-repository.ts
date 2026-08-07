import { ApiError } from '../../../common/errors/api-error';
import type { LabelsPort } from '../application/labels.types';

function unavailable(): never {
  throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}

export class UnavailableLabelsRepository implements LabelsPort {
  async listDetailFieldColumns() {
    return unavailable();
  }
  async listTemplates() {
    return unavailable();
  }
  async getTemplateById() {
    return unavailable();
  }
  async createTemplate() {
    return unavailable();
  }
  async updateTemplate() {
    return unavailable();
  }
  async deleteTemplate() {
    return unavailable();
  }
  async listQrTemplates() {
    return unavailable();
  }
  async createQrTemplate() {
    return unavailable();
  }
  async updateQrTemplate() {
    return unavailable();
  }
  async deleteQrTemplate() {
    return unavailable();
  }
  async getOrderLabelData() {
    return unavailable();
  }
  async updateOrderLabelData() {
    return unavailable();
  }
  async listOrderCutMapOptions() {
    return unavailable();
  }
  async previewOrderLabels() {
    return unavailable();
  }
  async generateOrderLabels() {
    return unavailable();
  }
  async previewDetailLabels() {
    return unavailable();
  }
  async generateDetailLabels() {
    return unavailable();
  }
  async getLatestOrderLabelsPreview() {
    return unavailable();
  }
  async exportOrderLabels() {
    return unavailable();
  }
  async exportDetailLabels() {
    return unavailable();
  }
  async getOrderLabelGenerationAccessDescriptor() {
    return unavailable();
  }
  async getDetailLabelGenerationAccessDescriptor() {
    return unavailable();
  }
  async recordPermissionDenied() {
    /* no-op: cannot audit without a DB */
  }
  async listActiveQrTemplateStrings() {
    return unavailable();
  }
  async listOcrTemplates() {
    return unavailable();
  }
  async createOcrTemplate() {
    return unavailable();
  }
  async updateOcrTemplate() {
    return unavailable();
  }
  async deleteOcrTemplate() {
    return unavailable();
  }
  async listActiveOcrTemplatesForMatch() {
    return unavailable();
  }
  async findScanCandidates() {
    return unavailable();
  }
}
