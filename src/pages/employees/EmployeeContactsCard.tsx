import { employeeContactsApi } from '../../api/employeeContactsApi';
import { ContactsCard, type ContactsSource } from '../../components/contacts/ContactsCard';

const EMPLOYEE_CONTACTS: ContactsSource = {
  load: (employeeId) => employeeContactsApi.get(employeeId),
  save: (employeeId, body) => employeeContactsApi.replace(employeeId, body),
  conflictCode: 'EMPLOYEE_CONTACTS_VERSION_CONFLICT',
  kinds: ['phone', 'email', 'telegram'],
  title: 'Рабочие контакты',
  hint: 'Основной телефон используется для отправок сотруднику в WhatsApp. Сотрудника с контактами нельзя удалить — снимите отметку «Активен».',
};

interface Props {
  employeeId: number | null | undefined;
  /** employees.manage: the editor; otherwise the read-only list. */
  editable: boolean;
}

/** «Рабочие контакты» of an employee. */
export const EmployeeContactsCard: React.FC<Props> = ({ employeeId, editable }) => (
  <ContactsCard ownerId={employeeId} editable={editable} source={EMPLOYEE_CONTACTS} />
);
