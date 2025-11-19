type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
    level: LogLevel;
    message: string;
    timestamp: string;
    meta?: Record<string, any>;
    error?: any;
}

function formatError(error: any): any {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...error,
        };
    }
    return error;
}

function log(level: LogLevel, message: string, meta?: Record<string, any>, error?: any) {
    const entry: LogEntry = {
        level,
        message,
        timestamp: new Date().toISOString(),
        meta,
    };

    if (error) {
        entry.error = formatError(error);
    }

    // In Vercel, console.log/error are captured by the logging system
    // We output JSON for better parsing in log drains
    console[level === 'error' ? 'error' : 'log'](JSON.stringify(entry));
}

export const logger = {
    info: (message: string, meta?: Record<string, any>) => log('info', message, meta),
    warn: (message: string, meta?: Record<string, any>, error?: any) => log('warn', message, meta, error),
    error: (message: string, error?: any, meta?: Record<string, any>) => log('error', message, meta, error),
};
