import type { ErrorRequestHandler, Response } from "express";

export const fail = (
  res: Response,
  status: number,
  error: string,
  message: string,
) => res.status(status).json({ error, message });

export const handleErrors: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error.type === "entity.parse.failed") {
    fail(res, 400, "MALFORMED", "invalid JSON");
    return;
  }

  fail(res, 500, "INTERNAL", error.message);
};
