import React from "react";
import { List, CreateButton } from "@refinedev/antd";
import { useResource } from "@refinedev/core";
import { ReferenceTableContext } from "../ui/tooltipDelay";
import { useOptionalUiVariant } from "../ui-variant/UiVariantProvider";
import { REFERENCE_DESCRIPTIONS, referenceGroupLabel } from "../utils/referenceCatalog";
import { ReferenceDrawerHost } from "./referenceDrawer/ReferenceDrawerHost";
import { useReferenceDrawerOpener } from "./referenceDrawer/ReferenceDrawerContext";

type ListProps = React.ComponentProps<typeof List>;

export const LocalizedList: React.FC<ListProps> = (props) => {
  // «NewLine»: экран-справочник — одна панель: группа над названием, строка «где используется» под ним.
  const isWorkbench = useOptionalUiVariant()?.variant === "workbench";
  const { resource } = useResource();
  const group = isWorkbench ? referenceGroupLabel(resource?.name) : null;
  const description = isWorkbench && resource?.name ? REFERENCE_DESCRIPTIONS[resource.name] : undefined;
  // Только справочники из перечня: прочие экраны на этой обёртке (документы 1С, потребности) оформлены отдельно.
  // экран сам оформлен панелью NewLine (например, «Пользователи»): кнопка создания — как у справочников
  const panel = !!group || (isWorkbench && String(props.wrapperProps?.className ?? "").split(/\s+/).includes("wb-refs"));
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
    {/* «NewLine»: запись справочника правится и добавляется в боковой панели над списком */}
    <ReferenceDrawerHost resource={resource?.name} title={props.title ?? resource?.meta?.label} enabled={!!group}>
      <LocalizedListBody listProps={{ ...props, ...workbenchProps }} panel={panel} />
    </ReferenceDrawerHost>
    </ReferenceTableContext.Provider>
  );
};

const LocalizedListBody: React.FC<{ listProps: ListProps; panel: boolean }> = ({ listProps, panel }) => {
  const drawer = useReferenceDrawerOpener();
  return (
    <List
      {...listProps}
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

          if (panel) {
            // в панели — та же кнопка refine (проверка прав сохраняется), щелчок открывает форму справа
            const onClick = drawer?.canOpen("create")
              ? (event: React.MouseEvent) => {
                  event.preventDefault();
                  drawer?.open("create");
                }
              : child.props.onClick;
            return React.cloneElement(child, { ...child.props, type: "primary", onClick }, "Добавить");
          }

          return React.cloneElement(child, child.props, "Создать");
        });
      }}
    />
  );
};
