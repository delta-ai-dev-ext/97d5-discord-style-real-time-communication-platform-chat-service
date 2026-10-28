import winston from "winston";

/**
 * Structured JSON logging (engineering guide § Observability).
 *
 * Every line carries `timestamp`, `level`, `service_name`, `message` plus
 * whatever request-scoped fields the caller bound (`request_id`, `trace_id`,
 * `operation`, `status`). Message content is never logged by this service.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogFields = Record<string, unknown>;

export interface AppLogger {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every line it writes. */
  child(fields: LogFields): AppLogger;
}

export const SERVICE_NAME = "chat_service";

const LEVEL_SEVERITY: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export interface FormatOptions {
  serviceName: string;
  timestamp: string;
}

/** Renders one structured log record as a single JSON line. */
export function formatLogLine(info: Record<string, unknown>, options: FormatOptions): string {
  const { level, message, ...rest } = info;

  return JSON.stringify({
    timestamp: options.timestamp,
    level,
    service_name: options.serviceName,
    message,
    ...rest,
  });
}

export interface LoggerOptions {
  level: LogLevel;
  serviceName?: string;
  /** Test seam: receives each rendered JSON line instead of stdout. */
  sink?: (line: string) => void;
}

class StructuredLogger implements AppLogger {
  constructor(
    private readonly logger: winston.Logger,
    private readonly level: LogLevel,
    private readonly bound: LogFields = {},
  ) {}

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  child(fields: LogFields): AppLogger {
    return new StructuredLogger(this.logger, this.level, { ...this.bound, ...fields });
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_SEVERITY[level] > LEVEL_SEVERITY[this.level]) {
      return;
    }

    this.logger.log(level, message, { ...this.bound, ...fields });
  }
}

export function createLogger(options: LoggerOptions): AppLogger {
  const serviceName = options.serviceName ?? SERVICE_NAME;
  const sink = options.sink;

  const logger = winston.createLogger({
    level: options.level,
    // `printf` renders the documented JSON shape and hands the line to the
    // optional sink, so lines reach the sink synchronously.
    format: winston.format.printf((info) => {
      const line = formatLogLine(info as unknown as Record<string, unknown>, {
        serviceName,
        timestamp: new Date().toISOString(),
      });

      if (sink) {
        sink(line);
        return "";
      }

      return line;
    }),
    transports: [new winston.transports.Console({ silent: sink !== undefined })],
  });

  return new StructuredLogger(logger, options.level);
}
