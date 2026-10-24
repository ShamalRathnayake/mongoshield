/**
 * MongoShield never logs on its own. Pass a logger to see what it is doing.
 * The interface is deliberately small so pino, winston, consola or `console`
 * can be adapted in one line.
 */

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const noop = (): void => {};

export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/** Minimal shape of a pino-style logger: `(fields, message)` argument order. */
export interface PinoLike {
  debug(fields: object, message: string): void;
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export function fromPino(pino: PinoLike): Logger {
  return {
    debug: (message, fields = {}) => pino.debug(fields, message),
    info: (message, fields = {}) => pino.info(fields, message),
    warn: (message, fields = {}) => pino.warn(fields, message),
    error: (message, fields = {}) => pino.error(fields, message),
  };
}
