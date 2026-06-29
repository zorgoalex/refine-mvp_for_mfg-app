import { ApiError } from '../../../common/errors/api-error';
import type { LabelsPort } from '../application/labels.types';

function unavailable(): never {
  throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}

export class UnavailableLabelsRepository implements LabelsPort {
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
  async getOrderLabelData() {
    return unavailable();
  }
  async updateOrderLabelData() {
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
  async recordPermissionDenied() {
    /* no-op: cannot audit without a DB */
  }
}
