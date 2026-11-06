import express from "express";
import axios from "axios";
import { createLogger } from "./log.ts";
import { fail, handleErrors, listen, originOf } from "./http.ts";
import { ROUTES, isHttpUrl, isObject, isRoute, isValidId, normalizeUrl } from "./protocol.ts";

export type Peer = { id: string; url: string };
export type BroadcastResult = Peer & { status: number; error?: string };
export type TrackerOptions = { port?: number; ttl?: number; timeout?: number };

export const startTracker = async ({ port = 4000, ttl = 30_000, timeout = 15_000 }: TrackerOptions = {}) => {
  const log = createLogger("tracker");
  const http = axios.create({ timeout, validateStatus: () => true });
  const registry = new Map<string, Peer & { expiresAt: number }>();
  const app = express();

  const removeExpired = () => {
    for (const [id, peer] of registry) {
      if (peer.expiresAt > Date.now()) continue;
      registry.delete(id);
      log.info(`${id} expired`);
    }
  };

  const livePeers = (): Peer[] => {
    removeExpired();
    return [...registry.values()].map(({ id, url }) => ({ id, url }));
  };

  const relay = async (target: Peer, origin: string, method: string, route: string, body: object): Promise<BroadcastResult> => {
    try {
      const response = await http.request({
        method,
        url: `${target.url}${route}`,
        headers: { Origin: origin },
        data: method === "POST" ? body : undefined,
      });
      return { ...target, status: response.status };
    } catch (error) {
      return { ...target, status: 0, error: (error as Error).message };
    }
  };

  app.use(express.json());

  app.post("/register", (req, res) => {
    const { id, url } = req.body ?? {};
    if (!isValidId(id) || !isHttpUrl(url)) {
      return fail(res, 400, "BAD_REQUEST", "expected { id, url } with id ^[A-Za-z0-9_-]{1,32}$ and an http(s) url");
    }
    const peerUrl = normalizeUrl(url);
    if (registry.get(id)?.url !== peerUrl) log.info(`${id} registered at ${peerUrl}`);
    registry.set(id, { id, url: peerUrl, expiresAt: Date.now() + ttl });
    res.sendStatus(204);
  });

  app.delete("/unregister/:id", (req, res) => {
    if (registry.delete(req.params.id)) log.info(`${req.params.id} unregistered`);
    res.sendStatus(204);
  });

  app.get("/peers", (_req, res) => {
    res.json({ peers: livePeers() });
  });

  app.post("/broadcast", async (req, res) => {
    const origin = originOf(req);
    if (!origin) return fail(res, 400, "MISSING_ORIGIN", "Origin header is required");

    const { route, method = route === "/health" ? "GET" : "POST", body = {} } = req.body ?? {};
    if (!isRoute(route)) return fail(res, 400, "BAD_ROUTE", `route must be one of ${ROUTES.join(", ")}`);
    if (method !== "GET" && method !== "POST") return fail(res, 400, "BAD_METHOD", "method must be GET or POST");
    if (!isObject(body)) return fail(res, 400, "BAD_BODY", "body must be an object");

    const peers = livePeers();
    const sender = peers.find((peer) => peer.url === origin);
    if (!sender) return fail(res, 403, "NOT_REGISTERED", "Origin is not registered");

    const targets = peers.filter((peer) => peer.id !== sender.id);
    log.info(`broadcast ${method} ${route} from ${sender.id} to ${targets.length} peer(s)`);
    const results = await Promise.all(targets.map((target) => relay(target, origin, method, route, body)));
    res.json({ results });
  });

  app.use(handleErrors);

  const server = await listen(app, port);
  const cleanup = setInterval(removeExpired, Math.max(500, ttl / 3));
  const url = `http://localhost:${server.port}`;
  log.info(`listening on ${url}`);

  return {
    url,
    registry,
    stop: async () => {
      clearInterval(cleanup);
      await server.close();
    },
  };
};
