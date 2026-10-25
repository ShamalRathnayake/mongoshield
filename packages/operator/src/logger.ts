/**
 * Structured logging: one JSON object per line on stdout.
 *
 * Log collectors (Loki, Cloud Logging, Elasticsearch) parse JSON lines into fields,
 * so `{"level":"info","msg":"reconciled","namespace":"prod","name":"nightly"}` can be
 * filtered by namespace or object without regular expressions.
 */

/** Extra fields attached to a log line. */
export type LogFields = Readonly<Record<string, unknown>>;

/** The logging interface every component receives. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every line (e.g. the controller name). */
  child(fields: LogFields): Logger;
}

/** Log levels in increasing severity. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Where log lines go; stdout by default, an array in tests. */
export type LogSink = (line: string) => void;

/** Creates a JSON-lines logger that drops lines below `level`. */
export function createLogger(
  level: LogLevel = "info",
  sink: LogSink = (line) => process.stdout.write(`${line}\n`),
  baseFields: LogFields = {},
): Logger {
  const write = (lineLevel: LogLevel, message: string, fields: LogFields = {}): void => {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) return;
    sink(
      JSON.stringify({
        time: new Date().toISOString(),
        level: lineLevel,
        msg: message,
        ...baseFields,
        ...fields,
      }),
    );
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(level, sink, { ...baseFields, ...fields }),
  };
}

/** A logger that discards everything (tests that don't care about logs). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
