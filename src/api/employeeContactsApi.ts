import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type { EmployeeContact, EmployeeContacts, EmployeeContactsReplace } from './employeeContactsApiTypes';

export const employeeContactsApi = {
  get: (employeeId: number) => httpClient.get<EmployeeContacts>(apiRoutes.employees.contacts(employeeId)),
  replace: (employeeId: number, body: EmployeeContactsReplace) =>
    httpClient.put<EmployeeContacts>(apiRoutes.employees.contacts(employeeId), body),
  /** Contacts of the employees on a list page. */
  list: (employeeIds: readonly number[]) =>
    httpClient.get<{ items: Array<{ employeeId: number; contacts: EmployeeContact[] }> }>(
      `${apiRoutes.employees.contactsList}?employeeIds=${employeeIds.map((id) => encodeURIComponent(String(id))).join(',')}`),
};
