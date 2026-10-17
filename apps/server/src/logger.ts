/** Minimal structured logger (pino-style API, zero deps). */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function level(): LogLevel {
  const l = (process.env.LOG_LEVEL || "info").toLowerCase();
  return (["debug", "info", "warn", "error"] as LogLevel[]).includes(l as LogLevel) ? (l as LogLevel) : "info";
}

function write(lv: LogLevel, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[lv] < ORDER[level()]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), lv, msg, ...fields });
  if (lv === "error" || lv === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function makeLogger(base: Record<string, unknown> = {}): Logger {
  return {
    debug: (msg, f) => write("debug", msg, { ...base, ...f }),
    info: (msg, f) => write("info", msg, { ...base, ...f }),
    warn: (msg, f) => write("warn", msg, { ...base, ...f }),
    error: (msg, f) => write("error", msg, { ...base, ...f }),
    child: (f) => makeLogger({ ...base, ...f }),
  };
}

export const logger: Logger = makeLogger({ svc: "tmin" });
