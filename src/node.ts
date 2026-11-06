import express, { type Request, type Response } from "express";
import axios from "axios";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { backoffDelay, fail, handleErrors, listen, originOf, retry } from "./http.ts";
import { createLogger } from "./log.ts";
import { createOutbox } from "./outbox.ts";
import { BROADCAST, isHttpUrl, isIngress, isValidId, normalizeUrl, type Ingress } from "./protocol.ts";
import { createTrackerClient } from "./tracker-client.ts";

type ConnectionState = "syn" | "syn-ack" | "ack";
type Method = "GET" | "POST";

export type Chat = { kind: "broadcast" | "private"; from: string; text: string };
export type SendResult = "delivered" | "queued" | "unknown";

export type NodeEvents = {
  chat: [chat: Chat];
  presence: [id: string, status: "online" | "offline"];
  connected: [url: string];
  forgotten: [url: string, reason: string];
};

const defaults = {
  port: 0,
  trackerUrl: "http://localhost:4000",
  timeout: 15_000,
  retries: 5,
  baseDelay: 1_000,
  maxDelay: 30_000,
  healthInterval: 5_000,
  maxMissedPongs: 5,
  discoverInterval: 3_000,
  registerInterval: 10_000,
  queueSize: 100,
  queueTtl: 10 * 60_000,
};

const DEDUP_TTL = 10 * 60_000;

export type NodeOptions = Partial<typeof defaults> & {
  id: string;
  publicUrl?: string;
  events?: EventEmitter<NodeEvents>;
};

export type Node = Awaited<ReturnType<typeof startNode>>;

export const startNode = async (options: NodeOptions) => {
  const settings = { ...defaults, ...options };
  if (!isValidId(settings.id)) throw new Error(`invalid id "${settings.id}"`);

  const log = createLogger(settings.id);
  const events = options.events ?? new EventEmitter<NodeEvents>();
  const tracker = createTrackerClient(settings.trackerUrl, log);
  const http = axios.create({ timeout: settings.timeout, validateStatus: () => true });
  const outbox = createOutbox<Ingress>({ maxSize: settings.queueSize, ttl: settings.queueTtl });

  const directory = new Map<string, string>();
  const connections = new Map<string, ConnectionState>();
  const missedPongs = new Map<string, number>();
  const healthChecks = new Set<string>();
  const formerPeers = new Set<string>();
  const reconnectPlan = new Map<string, { at: number; failures: number }>();
  const receivedMessages = new Map<string, number>();
  let selfUrl = "";
  let stopped = false;

  const nameOf = (url: string) => [...directory].find(([, peerUrl]) => peerUrl === url)?.[0] ?? url;
  const isConnected = (url: string) => connections.get(url) === "ack";
  const connectedUrls = () => [...connections.keys()].filter(isConnected);
  const errorMessage = (error: unknown) => (error as Error).message;

  const send = async (method: Method, url: string, route: string, body?: unknown) => {
    const response = await http.request({ method, url: `${url}${route}`, data: body, headers: { Origin: selfUrl } });
    if (response.status >= 500) throw new Error(`${route} answered ${response.status}`);
    return response.status;
  };

  const sendWithRetry = (method: Method, url: string, route: string, body?: unknown) =>
    retry(() => send(method, url, route, body), {
      retries: settings.retries,
      baseDelay: settings.baseDelay,
      maxDelay: settings.maxDelay,
      shouldStop: () => stopped,
      onRetry: (attempt, delay, error) =>
        log.warn(`${route} to ${nameOf(url)} failed (${error.message}), retry ${attempt}/${settings.retries} in ${delay}ms`),
    });

  const establish = (url: string) => {
    connections.set(url, "ack");
    missedPongs.set(url, 0);
    formerPeers.add(url);
    reconnectPlan.delete(url);
    if (nameOf(url) === url) void discover();
    log.info(`connected to ${nameOf(url)}`);
    events.emit("connected", url);
    void flushOutbox(url);
  };

  const drop = (url: string, reason: string) => {
    const previous = connections.get(url);
    if (!previous) return undefined;
    connections.delete(url);
    missedPongs.delete(url);
    log.warn(`connection with ${nameOf(url)} forgotten (${reason})`);
    events.emit("forgotten", url, reason);
    return previous;
  };

  const forget = async (url: string, reason: string) => {
    if (drop(url, reason) !== "ack") return;
    await send("POST", url, "/forget").catch(() => undefined);
  };

  const answerSyn = async (url: string) => {
    try {
      const status = await sendWithRetry("POST", url, "/syn-ack");
      if (status !== 202) drop(url, `syn-ack refused (${status})`);
    } catch {
      if (connections.get(url) === "syn") drop(url, "syn-ack unreachable");
    }
  };

  const confirmSynAck = async (url: string) => {
    try {
      const status = await sendWithRetry("POST", url, "/ack");
      if (status !== 204) {
        drop(url, `ack refused (${status})`);
      } else if (connections.get(url) === "syn-ack") {
        establish(url);
      }
    } catch {
      drop(url, "ack unreachable");
    }
  };

  const isDuplicate = (message: Ingress) => {
    const now = Date.now();
    for (const [key, receivedAt] of receivedMessages) {
      if (now - receivedAt > DEDUP_TTL) receivedMessages.delete(key);
    }
    const key = message.metadata.id ?? JSON.stringify(message);
    if (receivedMessages.has(key)) return true;
    receivedMessages.set(key, now);
    return false;
  };

  const receive = (message: Ingress) => {
    const sender = nameOf(normalizeUrl(message.metadata.source));
    if (message.action !== "message") {
      log.info(`ignored action "${message.action}" from ${sender}`);
      return;
    }
    const kind = message.metadata.target === BROADCAST ? "broadcast" : "private";
    events.emit("chat", { kind, from: sender, text: String(message.payload?.text ?? "") });
  };

  const requireOrigin = (req: Request, res: Response) => {
    const origin = originOf(req);
    if (!origin) fail(res, 400, "MISSING_ORIGIN", "Origin header is required");
    return origin;
  };

  const app = express();
  app.use(express.json());

  app.post("/syn", (req, res) => {
    const peer = requireOrigin(req, res);
    if (!peer) return;
    if (peer === selfUrl) return fail(res, 400, "SELF", "a node cannot connect to itself");
    connections.set(peer, "syn");
    log.info(`syn received from ${nameOf(peer)}`);
    res.sendStatus(202);
    void answerSyn(peer);
  });

  app.post("/syn-ack", (req, res) => {
    const peer = requireOrigin(req, res);
    if (!peer) return;
    if (connections.get(peer) !== "syn") return fail(res, 403, "NOT_CONTACTED", "/syn required first");
    connections.set(peer, "syn-ack");
    res.sendStatus(202);
    void confirmSynAck(peer);
  });

  app.post("/ack", (req, res) => {
    const peer = requireOrigin(req, res);
    if (!peer) return;
    if (connections.get(peer) !== "syn") return fail(res, 403, "NOT_SYN", "/syn-ack required first");
    establish(peer);
    res.sendStatus(204);
  });

  app.post("/forget", (req, res) => {
    const peer = requireOrigin(req, res);
    if (!peer) return;
    if (!isConnected(peer)) return fail(res, 403, "NOT_ACK", "connection not established");
    drop(peer, "remote forget");
    res.sendStatus(204);
  });

  app.post("/ingress", (req, res) => {
    const peer = requireOrigin(req, res);
    if (!peer) return;
    if (connections.get(peer) === "syn-ack") establish(peer);
    if (!isConnected(peer)) return fail(res, 403, "NOT_CONNECTED", "no established connection with this Origin");
    if (!isIngress(req.body)) return fail(res, 400, "MALFORMED", "expected { action, metadata: { source, target, timestamp }, payload? }");
    if (isDuplicate(req.body)) return fail(res, 208, "DUPLICATE", "message already received");
    const message = req.body;
    res.sendStatus(201);
    setImmediate(() => receive(message));
  });

  app.get("/health", (req, res) => {
    const peer = originOf(req);
    if (!peer) return res.sendStatus(204);
    res.sendStatus(202);
    if (isConnected(peer)) send("POST", peer, "/pong").catch(() => undefined);
  });

  app.post("/pong", (req, res) => {
    const peer = requireOrigin(req, res);
    if (!peer) return;
    if (!connections.has(peer)) return fail(res, 403, "UNKNOWN", "unknown server");
    missedPongs.set(peer, 0);
    res.sendStatus(204);
  });

  app.use(handleErrors);

  const checkHealth = async (url: string) => {
    healthChecks.add(url);
    try {
      if ((missedPongs.get(url) ?? 0) >= settings.maxMissedPongs) {
        await forget(url, `no pong after ${settings.maxMissedPongs} pings`);
        return;
      }
      const status = await sendWithRetry("GET", url, "/health");
      if (status !== 202) {
        drop(url, `health answered ${status}`);
      } else if (isConnected(url)) {
        missedPongs.set(url, (missedPongs.get(url) ?? 0) + 1);
      }
    } catch {
      if (!stopped) await forget(url, "health unreachable");
    } finally {
      healthChecks.delete(url);
    }
  };

  const checkConnections = () => {
    for (const url of connectedUrls()) {
      if (!healthChecks.has(url)) void checkHealth(url);
    }
  };

  const refreshDirectory = async () => {
    let registered;
    try {
      registered = await tracker.peers();
    } catch (error) {
      log.warn(`cannot list peers (${errorMessage(error)})`);
      return;
    }

    const current = new Map<string, string>();
    for (const { id, url } of registered) {
      if (isValidId(id) && isHttpUrl(url) && normalizeUrl(url) !== selfUrl) current.set(id, normalizeUrl(url));
    }

    for (const [id, url] of directory) {
      if (current.get(id) === url) continue;
      directory.delete(id);
      events.emit("presence", id, "offline");
    }
    for (const [id, url] of current) {
      if (directory.has(id)) continue;
      directory.set(id, url);
      events.emit("presence", id, "online");
    }
  };

  const reconnect = async (url: string) => {
    connections.set(url, "syn");
    log.info(`reconnecting to ${nameOf(url)}`);
    try {
      const status = await send("POST", url, "/syn");
      if (status !== 202) drop(url, `syn refused (${status})`);
    } catch (error) {
      if (connections.get(url) === "syn") drop(url, `syn failed (${errorMessage(error)})`);
    }
    if (connections.has(url)) return;
    const failures = (reconnectPlan.get(url)?.failures ?? 0) + 1;
    reconnectPlan.set(url, { failures, at: Date.now() + backoffDelay(failures - 1, settings) });
  };

  const reconnectLostPeers = () => {
    for (const url of directory.values()) {
      const lost = formerPeers.has(url) && !connections.has(url);
      const myTurn = selfUrl < url;
      const due = (reconnectPlan.get(url)?.at ?? 0) <= Date.now();
      if (lost && myTurn && due) void reconnect(url);
    }
  };

  const discover = async () => {
    await refreshDirectory();
    reconnectLostPeers();
  };

  const joinNetwork = async () => {
    for (const url of directory.values()) {
      if (!connections.has(url)) connections.set(url, "syn");
    }
    try {
      const results = await tracker.broadcast(selfUrl, "/syn");
      log.info(`syn broadcast to ${results.length} peer(s)`);
      for (const { id, url, status } of results) {
        if (status === 202) continue;
        log.warn(`${id} answered ${status} to syn`);
        if (connections.get(normalizeUrl(url)) === "syn") drop(normalizeUrl(url), `syn answered ${status}`);
      }
    } catch (error) {
      log.warn(`syn broadcast failed (${errorMessage(error)})`);
    }
  };

  const createMessage = (target: string, text: string): Ingress => ({
    action: "message",
    metadata: { id: randomUUID(), source: selfUrl, target, timestamp: new Date().toISOString() },
    payload: { text },
  });

  const deliver = async (url: string, message: Ingress) => {
    try {
      const status = await sendWithRetry("POST", url, "/ingress", message);
      if (status === 201 || status === 208) return true;
      log.warn(`${nameOf(url)} refused the message (${status})`);
      if (status === 403) drop(url, "peer no longer knows us");
    } catch (error) {
      log.warn(`cannot deliver to ${nameOf(url)} (${errorMessage(error)})`);
    }
    return false;
  };

  const flushOutbox = async (url: string) => {
    const waiting = outbox.take(url);
    if (waiting.length === 0) return;
    log.info(`sending ${waiting.length} queued message(s) to ${nameOf(url)}`);
    for (const [index, message] of waiting.entries()) {
      if (!(await deliver(url, message))) {
        outbox.putBack(url, waiting.slice(index));
        return;
      }
    }
  };

  const urlOf = (peer: string) => directory.get(peer) ?? (isHttpUrl(peer) ? normalizeUrl(peer) : undefined);

  const sendTo = async (peer: string, text: string): Promise<SendResult> => {
    if (!urlOf(peer)) await refreshDirectory();
    const url = urlOf(peer);
    if (!url) return "unknown";

    const message = createMessage(url, text);
    if (isConnected(url) && (await deliver(url, message))) return "delivered";

    const pending = outbox.add(url, message);
    log.info(`message for ${nameOf(url)} queued (${pending} pending)`);
    return "queued";
  };

  const sendToAll = async (text: string) => {
    const results = await tracker.broadcast(selfUrl, "/ingress", createMessage(BROADCAST, text));
    return results.filter(({ status }) => status === 201).length;
  };

  const server = await listen(app, settings.port);
  selfUrl = normalizeUrl(settings.publicUrl ?? `http://localhost:${server.port}`);

  const register = () => tracker.register({ id: settings.id, url: selfUrl });
  await register();
  await refreshDirectory();
  await joinNetwork();

  const timers = [
    setInterval(register, settings.registerInterval),
    setInterval(discover, settings.discoverInterval),
    setInterval(checkConnections, settings.healthInterval),
  ];
  log.info(`ready on ${selfUrl}`);

  const stop = async ({ graceful = true } = {}) => {
    stopped = true;
    timers.forEach(clearInterval);
    if (graceful) {
      await Promise.all(connectedUrls().map((url) => forget(url, "quit")));
      await tracker.unregister(settings.id);
    }
    await server.close();
  };

  return {
    id: settings.id,
    url: selfUrl,
    events,
    online: () => [...directory.keys()],
    connected: () => connectedUrls().map(nameOf),
    pendingMessages: () => outbox.size(),
    sendTo,
    sendToAll,
    stop,
  };
};
