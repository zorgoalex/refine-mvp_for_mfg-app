export interface DeadlineSettingsDto {
  reminderEventsEnabled: boolean;
  notifyAssigneeEnabled: boolean;
  notifyManagerEnabled: boolean;
  notifyDepartmentHeadEnabled: boolean;
  setOverdueFlagEnabled: boolean;
  changeOrderStatusEnabled: boolean;
  changeProductionStatusEnabled: boolean;
  escalationEnabled: boolean;
  repeatNotificationsEnabled: boolean;
}

export interface DeadlineSettingsResponseDto {
  settings: DeadlineSettingsDto;
}

export type UpdateDeadlineSettingsRequestDto = Partial<DeadlineSettingsDto>;

export const DEFAULT_DEADLINE_SETTINGS: DeadlineSettingsDto = {
  reminderEventsEnabled: true,
  notifyAssigneeEnabled: false,
  notifyManagerEnabled: false,
  notifyDepartmentHeadEnabled: false,
  setOverdueFlagEnabled: false,
  changeOrderStatusEnabled: false,
  changeProductionStatusEnabled: false,
  escalationEnabled: false,
  repeatNotificationsEnabled: false,
};
