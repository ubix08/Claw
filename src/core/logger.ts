// src/core/logger.ts
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";
const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

class Logger {
  private level: LogLevel = "info";
  setLevel(l: LogLevel): void { this.level = l; }
  getLevel(): LogLevel         { return this.level; }
  private log(level: LogLevel, msg: string): void {
    if (LEVELS[level] > LEVELS[this.level]) return;
    const ts     = new Date().toISOString().slice(11, 23);
    const prefix = ({ error: "ERR", warn: "WRN", info: "INF", debug: "DBG", silent: "" })[level];
    const out    = level === "error" ? process.stderr : process.stdout;
    out.write(`[${ts}] ${prefix} ${msg}\n`);
  }
  error(m: string): void { this.log("error", m); }
  warn (m: string): void { this.log("warn",  m); }
  info (m: string): void { this.log("info",  m); }
  debug(m: string): void { this.log("debug", m); }
}
export const logger = new Logger();
