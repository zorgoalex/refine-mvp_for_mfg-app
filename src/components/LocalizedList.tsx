import React from "react";
import { List, CreateButton } from "@refinedev/antd";

type ListProps = React.ComponentProps<typeof List>;

export const LocalizedList: React.FC<ListProps> = (props) => {
  return (
    <List
      {...props}
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

          return React.cloneElement(child, child.props, "Создать");
        });
      }}
    />
  );
};
