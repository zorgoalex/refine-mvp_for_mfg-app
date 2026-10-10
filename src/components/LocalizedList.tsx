import React from "react";
import { List, CreateButton } from "@refinedev/antd";
import { useResource } from "@refinedev/core";
import { ReferenceTableContext } from "../ui/tooltipDelay";
import { useOptionalUiVariant } from "../ui-variant/UiVariantProvider";
import { REFERENCE_DESCRIPTIONS, referenceGroupLabel } from "../utils/referenceCatalog";

type ListProps = React.ComponentProps<typeof List>;

export const LocalizedList: React.FC<ListProps> = (props) => {
  // «NewLine»: экран-справочник — одна панель: группа над названием, строка «где используется» под ним.
  const isWorkbench = useOptionalUiVariant()?.variant === "workbench";
  const { resource } = useResource();
  const group = isWorkbench ? referenceGroupLabel(resource?.name) : null;
  const description = isWorkbench && resource?.name ? REFERENCE_DESCRIPTIONS[resource.name] : undefined;
  // Только справочники из перечня: прочие экраны на этой обёртке (документы 1С, потребности) оформлены отдельно.
  const workbenchProps: Partial<ListProps> = group ? {
    wrapperProps: {
      ...props.wrapperProps,
      className: [props.wrapperProps?.className, "wb-list wb-refs"].filter(Boolean).join(" "),
    },
    title: (
      <span className="wb-refs__heading">
        <span className="wb-refs__group">{group}</span>
        <span className="wb-refs__title">{props.title ?? resource?.meta?.label}</span>
        {description ? <span className="wb-refs__desc">{description}</span> : null}
      </span>
    ),
  } : {};

  return (
    <ReferenceTableContext.Provider value={true}>
    <List
      {...props}
      {...workbenchProps}
      headerButtons={(headerProps) => {
        const { defaultButtons } = headerProps;

        return React.Children.map(defaultButtons, (child) => {
          if (!React.isValidElement(child)) {
            return child;
          }

          const isCreateButton =
            child.type === CreateButton ||
            // на случай, если тип обёрнут
            // и CreateButton имеет displayName
            // (защита от разных версий refine)
            // @ts-ignore
            child.type?.displayName === "CreateButton";

          if (!isCreateButton) {
            return child;
          }

          if (group) {
            return React.cloneElement(child, { ...child.props, type: "primary" }, "Добавить");
          }

          return React.cloneElement(child, child.props, "Создать");
        });
      }}
    />
    </ReferenceTableContext.Provider>
  );
};
