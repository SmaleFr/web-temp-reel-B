export const ROUTES = ["/syn", "/syn-ack", "/ack", "/forget", "/ingress", "/health", "/pong"] as const;
export const BROADCAST = "*";

export type Route = (typeof ROUTES)[number];

export type Ingress = {
  action: string;
  metadata: { id?: string; source: string; target: string; timestamp: string };
  payload?: Record<string, unknown>;
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const isValidId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

export const isHttpUrl = (value: unknown): value is string => typeof value === "string" && /^https?:\/\/.+/.test(value);

export const isRoute = (value: unknown): value is Route => ROUTES.includes(value as Route);

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

export const isIngress = (value: unknown): value is Ingress => {
  if (!isObject(value) || !isObject(value.metadata)) return false;
  const { action, metadata, payload } = value;
  return (
    typeof action === "string" &&
    action.length > 0 &&
    typeof metadata.source === "string" &&
    typeof metadata.target === "string" &&
    typeof metadata.timestamp === "string" &&
    !Number.isNaN(Date.parse(metadata.timestamp)) &&
    (metadata.id === undefined || typeof metadata.id === "string") &&
    (payload === undefined || isObject(payload))
  );
};
