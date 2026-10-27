import { maskMobilesInText } from "@goldloan/shared";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * JSON-lines logger. Every line passes through `maskMobilesInText`, so a mobile number can
 * never reach the logs in clear text, whichever field or nested object it hides in.
 */
export type LogSink = (line: string, level: Level) => void;

const stdioSink: LogSink = (line, level) => {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

export function createLogger(level: Level | "silent" = "info", sink: LogSink = stdioSink): Logger {
  const threshold = ORDER[level];
  const write = (lvl: Level, message: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: message, ...fields });
    sink(maskMobilesInText(line), lvl);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
