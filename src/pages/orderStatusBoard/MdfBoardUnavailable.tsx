import { Alert, Button } from 'antd';
import React from 'react';

/** §5.6 requirement 1: shown whenever the engine is active/read_only but published reads are
 * disabled or failing, or the engine-mode request itself failed for a reason other than 404.
 * Never falls back to legacy rendering. */
export const MdfBoardUnavailable: React.FC<{ onRetry: () => void; loading?: boolean }> = ({ onRetry, loading }) => (
  <Alert
    className="mdf-published-board__unavailable"
    type="error"
    showIcon
    message="Производственный учёт недоступен"
    description="Не удалось прочитать согласованное состояние МДФ-доски. Отображение старой доски отключено, чтобы не показать несогласованные данные."
    action={
      <Button size="small" loading={loading} onClick={onRetry}>
        Повторить
      </Button>
    }
  />
);
