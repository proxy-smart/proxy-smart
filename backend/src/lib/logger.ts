// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Logger Configuration
 * 
 * Centralized logging configuration for the SMART on FHIR backend.
 * Provides structured logging with different levels and formatting.
 */

export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4
}

export interface LogEntry {
  timestamp: string;
  level: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
  error?: Error;
}

export interface LoggerConfig {
  level: LogLevel;
  format: 'json' | 'pretty';
  enableColors: boolean;
  enableTimestamp: boolean;
  categories: {
    [key: string]: LogLevel;
  };
}

// Default configuration
const getDefaultConfig = (): LoggerConfig => {
  // LOG_LEVEL env override takes precedence (useful for CI diagnostics)
  const envLevel = process.env.LOG_LEVEL?.toUpperCase() as keyof typeof LogLevel | undefined;
  const baseLevel = envLevel && LogLevel[envLevel] !== undefined
    ? LogLevel[envLevel] as number
    : process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
  
  return {
    level: baseLevel,
    format: process.env.NODE_ENV === 'production' ? 'json' : 'pretty',
    enableColors: process.env.NODE_ENV !== 'production',
    enableTimestamp: true,
    categories: {
      'server': Math.max(LogLevel.INFO, baseLevel),
      'keycloak': Math.max(LogLevel.INFO, baseLevel),
      'fhir': Math.max(LogLevel.INFO, baseLevel),
      'auth': Math.max(LogLevel.INFO, baseLevel),
      'admin': Math.max(LogLevel.DEBUG, baseLevel),
      'routes': Math.max(LogLevel.DEBUG, baseLevel),
      'database': Math.max(LogLevel.WARN, baseLevel),
      'security': Math.max(LogLevel.WARN, baseLevel),
      'performance': Math.max(LogLevel.INFO, baseLevel),
      'sse': Math.max(LogLevel.INFO, baseLevel),
      'ws': Math.max(LogLevel.INFO, baseLevel),
      'consent': Math.max(LogLevel.INFO, baseLevel)
    }
  };
};

const defaultConfig = getDefaultConfig();

class Logger {
  private config: LoggerConfig;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...defaultConfig, ...config };
  }

  private shouldLog(level: LogLevel, category: string): boolean {
    const categoryLevel = this.config.categories[category] ?? this.config.level;
    return level <= categoryLevel;
  }

  private formatMessage(entry: LogEntry): string {
    if (this.config.format === 'json') {
      return JSON.stringify(entry);
    }

    // Pretty format
    const timestamp = this.config.enableTimestamp ? `[${entry.timestamp}] ` : '';
    const level = this.config.enableColors ? this.colorizeLevel(entry.level) : entry.level;
    const category = this.config.enableColors ? `\x1b[36m${entry.category}\x1b[0m` : entry.category;
    
    let message = `${timestamp}${level} [${category}] ${entry.message}`;
    
    if (entry.data) {
      message += `\n${JSON.stringify(entry.data, null, 2)}`;
    }
    
    if (entry.error) {
      message += `\n${entry.error.stack || entry.error.message}`;
    }
    
    return message;
  }

  private colorizeLevel(level: string): string {
    switch (level.toLowerCase()) {
      case 'error': return `\x1b[31m${level}\x1b[0m`; // Red
      case 'warn':  return `\x1b[33m${level}\x1b[0m`; // Yellow
      case 'info':  return `\x1b[32m${level}\x1b[0m`; // Green
      case 'debug': return `\x1b[34m${level}\x1b[0m`; // Blue
      case 'trace': return `\x1b[35m${level}\x1b[0m`; // Magenta
      default:      return level;
    }
  }

  private log(level: LogLevel, category: string, message: string, data?: Record<string, unknown>, error?: Error): void {
    if (!this.shouldLog(level, category)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: LogLevel[level].toLowerCase(),
      category,
      message,
      data,
      error
    };

    const formattedMessage = this.formatMessage(entry);
    
    // Output to appropriate stream
    if (level <= LogLevel.WARN) {
      console.error(formattedMessage);
    } else {
      console.log(formattedMessage);
    }
  }

  // Public logging methods
  error(category: string, message: string, data?: Record<string, unknown>, error?: Error): void {
    this.log(LogLevel.ERROR, category, message, data, error);
  }

  warn(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, category, message, data);
  }

  info(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, category, message, data);
  }

  debug(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, category, message, data);
  }

  trace(category: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.TRACE, category, message, data);
  }

  // Convenience methods for common categories
  server = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('server', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('server', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('server', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('server', message, data)
  };

  keycloak = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('keycloak', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('keycloak', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('keycloak', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('keycloak', message, data)
  };

  fhir = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('fhir', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('fhir', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('fhir', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('fhir', message, data)
  };

  auth = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('auth', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('auth', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('auth', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('auth', message, data)
  };

  admin = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('admin', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('admin', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('admin', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('admin', message, data)
  };

  security = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('security', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('security', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('security', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('security', message, data)
  };

  performance = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('performance', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('performance', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('performance', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('performance', message, data)
  };

  sse = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('sse', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('sse', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('sse', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('sse', message, data)
  };

  ws = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('ws', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('ws', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('ws', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('ws', message, data)
  };

  consent = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('consent', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('consent', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('consent', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('consent', message, data)
  };

  email = {
    error: (message: string, data?: Record<string, unknown>, error?: Error) => this.error('email', message, data, error),
    warn: (message: string, data?: Record<string, unknown>) => this.warn('email', message, data),
    info: (message: string, data?: Record<string, unknown>) => this.info('email', message, data),
    debug: (message: string, data?: Record<string, unknown>) => this.debug('email', message, data)
  };
}

// Create and export singleton logger instance
export const logger = new Logger();

// Export factory function for custom logger instances
export function createLogger(config: Partial<LoggerConfig> = {}): Logger {
  return new Logger(config);
}

// Performance timing utility
export class PerformanceTimer {
  private startTime: number;
  private category: string;
  private operation: string;

  constructor(category: string, operation: string) {
    this.category = category;
    this.operation = operation;
    this.startTime = performance.now();
    logger.debug(category, `Starting ${operation}`);
  }

  end(additionalData?: Record<string, unknown>): number {
    const duration = performance.now() - this.startTime;
    logger.performance.info(`${this.operation} completed`, {
      category: this.category,
      duration: `${duration.toFixed(2)}ms`,
      ...additionalData
    });
    return duration;
  }
}

// Express/Elysia middleware for request logging
export function createRequestLogger() {
  return (request: Request, set?: Record<string, unknown>, next?: () => Promise<void>) => {
    const timer = new PerformanceTimer('routes', `${request.method} ${request.url}`);
    
    logger.debug('routes', `Incoming request`, {
      method: request.method,
      url: request.url,
      userAgent: request.headers.get('user-agent') || undefined,
      ip: request.headers.get('x-forwarded-for') || undefined
    });

    // For Elysia, we need to handle the response differently
    if (next) {
      return next().finally(() => {
        timer.end({
          statusCode: (set as Record<string, unknown>)?.status || 200
        });
      });
    } else {
      // Direct response handling
      timer.end();
    }
  };
}
