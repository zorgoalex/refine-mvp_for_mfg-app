import { useState } from "react";
import { nameRule } from '../../utils/nameRules';
import { Edit } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, Checkbox } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";
import { ContactsCard } from "../../components/contacts/ContactsCard";
import { SUPPLIER_CONTACTS } from "../../components/contacts/partyContactsSources";
import { can } from "../../utils/permissions";
import { SupplierCounterpartyCard } from "./SupplierCounterpartyCard";

export const SupplierEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, queryResult } = useFormWithHighlight({
    resource: "suppliers",
    idField: "supplier_id",
    action: "edit",
  });

  const supplierId = Number(queryResult?.data?.data?.supplier_id) || null;
  const canManage = can("suppliers.manage");
  // A link change or a sync with 1C changes the contacts: the contacts block re-reads them.
  const [contactsToken, setContactsToken] = useState(0);
  const [contactsDirty, setContactsDirty] = useState(false);
  const [counterpartyBusy, setCounterpartyBusy] = useState(false);

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item label="Name" name="supplier_name" rules={[...([{ required: true }]), nameRule("supplier_name")]}>
          <Input />
        </Form.Item>
        <Form.Item label="Address" name="address">
          <Input />
        </Form.Item>
        <Form.Item label="Contact Person" name="contact_person">
          <Input />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <ReferenceSortOrderFormItem />
      </Form>
      {/* Phones, emails and Telegram — the contacts block; the 1C link — its own command (neither goes through this form). */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <ContactsCard ownerId={supplierId} editable={canManage} source={SUPPLIER_CONTACTS} reloadToken={contactsToken} onDirtyChange={setContactsDirty}
          locked={counterpartyBusy} />
        <SupplierCounterpartyCard supplierId={supplierId} editable={canManage} onContactsChanged={() => setContactsToken((token) => token + 1)}
          contactsDirty={contactsDirty} onBusyChange={setCounterpartyBusy} />
      </div>
    </Edit>
  );
};

