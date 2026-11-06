type Level = "debug" | "info" | "warn" | "error";

export type Logger = Record<Level, (message: string) => void>;

const priority: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

let output = (line: string) => console.log(line);

export const setLogOutput = (write: (line: string) => void) => {
  output = write;
};

const minimumPriority = () => priority[process.env.LOG_LEVEL as Level] ?? priority.info;

export const createLogger = (name: string): Logger => {
  const logAt = (level: Level) => (message: string) => {
    if (priority[level] < minimumPriority()) return;
    const time = new Date().toISOString().slice(11, 23);
    output(`${time} ${level.toUpperCase().padEnd(5)} [${name}] ${message}`);
  };

  return { debug: logAt("debug"), info: logAt("info"), warn: logAt("warn"), error: logAt("error") };
};
