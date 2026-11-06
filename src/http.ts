import type { ErrorRequestHandler, Express, Request, Response } from "express";
import type { AddressInfo } from "node:net";
import { normalizeUrl } from "./protocol.ts";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type BackoffSettings = { retries: number; baseDelay: number; maxDelay: number };

export const backoffDelay = (attempt: number, { baseDelay, maxDelay }: BackoffSettings) =>
  Math.min(baseDelay * 2 ** attempt, maxDelay);

type RetryOptions = BackoffSettings & {
  shouldStop?: () => boolean;
  onRetry?: (attempt: number, delay: number, error: Error) => void;
};

export const retry = async <T>(task: () => Promise<T>, options: RetryOptions): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= options.retries || options.shouldStop?.()) throw error;
      const delay = backoffDelay(attempt, options);
      options.onRetry?.(attempt + 1, delay, error as Error);
      await sleep(delay);
    }
  }
};

export const fail = (res: Response, status: number, error: string, message: string) =>
  res.status(status).json({ error, message });

export const originOf = (req: Request) => {
  const origin = req.headers.origin;
  return typeof origin === "string" && origin.trim() ? normalizeUrl(origin) : undefined;
};

export const handleErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    fail(res, 400, "MALFORMED", "invalid JSON");
    return;
  }
  fail(res, 500, "INTERNAL", error.message);
};

export const listen = (app: Express, port: number) =>
  new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const server = app.listen(port, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
