import React from "react";
import { notification } from "antd";
import { useAppTheme } from "../../theme/ThemeProvider";
import { hasAnyDirty, useTabStore } from "../../stores/tabStore";

/** Переключение планшетного вида: не при несохранённых вкладках, с сообщением об ошибке. */
export function useTabletModeToggle() {
  const { tabletMode, setTabletMode } = useAppTheme();
  const [isTabletModeSaving, setIsTabletModeSaving] = React.useState(false);

  const toggleTabletMode = async () => {
    if (hasAnyDirty(useTabStore.getState().tabs)) {
      notification.warning({
        message: "Есть несохранённые изменения",
        description: "Сохраните или отмените изменения во вкладках, затем переключите вид.",
      });
      return;
    }

    setIsTabletModeSaving(true);
    try {
      await setTabletMode(!tabletMode);
    } catch {
      notification.error({
        message: "Не удалось переключить планшетный вид",
        description: "Настройка не изменена. Попробуйте ещё раз.",
      });
    } finally {
      setIsTabletModeSaving(false);
    }
  };

  return { tabletMode, isTabletModeSaving, toggleTabletMode };
}
