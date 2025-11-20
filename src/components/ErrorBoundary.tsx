import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button, Result } from 'antd';
import { logError } from '../utils/notificationLogger';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary для перехвата ошибок React
 * Логирует все ошибки в систему уведомлений
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught error:', error, errorInfo);

    // Логируем ошибку в систему уведомлений
    const errorMessage = `${error.name}: ${error.message}`;
    logError(errorMessage, 'error', false);

    // В dev режиме также выводим stack trace
    if (import.meta.env.DEV) {
      console.error('Component stack:', errorInfo.componentStack);
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      return (
        <Result
          status="error"
          title="Произошла ошибка"
          subTitle={
            import.meta.env.DEV
              ? this.state.error?.message
              : 'Извините, произошла непредвиденная ошибка. Попробуйте обновить страницу.'
          }
          extra={
            <Button type="primary" onClick={this.handleReset}>
              Вернуться на главную
            </Button>
          }
        />
      );
    }

    return this.props.children;
  }
}
