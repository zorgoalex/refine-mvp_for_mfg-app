(() => {
  "use strict";
  const notice = document.getElementById("notice");
  if (!window.BX24) {
    notice.textContent = "Не загрузился официальный SDK Bitrix24. Повторите установку.";
    notice.className = "notice error";
    return;
  }
  BX24.init(() => {
    try {
      // This API has no callback. Bitrix reloads /app with a fresh authenticated
      // form POST; the backend resumes the matching persisted install attempt.
      BX24.installFinish();
    } catch {
      notice.textContent = "Не удалось завершить установку в Bitrix24. Откройте приложение повторно.";
      notice.className = "notice error";
    }
  });
})();
