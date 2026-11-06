class Logger {
  info(message: string, object?: Record<string, unknown>): void {
    console.log(`[INFO] ${new Date().toISOString()} -  ${message}`, object);
  }

  warn(message: string, object?: Record<string, unknown>): void {
    console.warn(`[WARN] ${new Date().toISOString()} -  ${message}`, object);
  }

  error(message: string, object?: Record<string, unknown>): void {
    console.error(`[ERROR] ${new Date().toISOString()} -  ${message}`, object);
  }
}

export const logger = new Logger();
