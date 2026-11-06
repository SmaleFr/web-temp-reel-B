import { once } from "node:events";

process.env.LOG_LEVEL ??= "silent";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const waitFor = async (predicate: () => boolean, timeout = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(20);
  }
};

export const nextEvent = <T extends unknown[]>(emitter: NodeJS.EventEmitter, name: string, timeout = 3000) =>
  once(emitter, name, { signal: AbortSignal.timeout(timeout) }) as Promise<T>;

export const collect = <T extends unknown[]>(emitter: NodeJS.EventEmitter, name: string) => {
  const items: T[] = [];
  emitter.on(name, (...args: T) => items.push(args));
  return items;
};

