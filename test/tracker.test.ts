import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { waitFor } from "./helpers.ts";
import express from "express";
import type { Server } from "node:http";
import { startTracker } from "../src/tracker.ts";

const http = axios.create({ validateStatus: () => true });
let tracker: Awaited<ReturnType<typeof startTracker>>;

before(async () => {
  tracker = await startTracker({ port: 0, ttl: 600 });
});

after(() => tracker.stop());

test("register then list peers", async () => {
  assert.equal((await http.post(`${tracker.url}/register`, { id: "alice", url: "http://localhost:6001" })).status, 204);
  assert.equal((await http.post(`${tracker.url}/register`, { id: "bob", url: "http://localhost:6002/" })).status, 204);
  const { status, data } = await http.get(`${tracker.url}/peers`);
  assert.equal(status, 200);
  assert.deepEqual(data.peers.sort((a: any, b: any) => a.id.localeCompare(b.id)), [
    { id: "alice", url: "http://localhost:6001" },
    { id: "bob", url: "http://localhost:6002" },
  ]);
});

test("register rejects invalid bodies", async () => {
  for (const body of [{}, { id: "x" }, { url: "http://a" }, { id: "bad id", url: "http://a" }, { id: "x", url: "ws://a" }]) {
    assert.equal((await http.post(`${tracker.url}/register`, body)).status, 400, JSON.stringify(body));
  }
  const bad = await http.post(`${tracker.url}/register`, "{oops", { headers: { "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);
});

test("unregister removes an entry and is idempotent", async () => {
  await http.post(`${tracker.url}/register`, { id: "carol", url: "http://localhost:6003" });
  assert.equal((await http.delete(`${tracker.url}/unregister/carol`)).status, 204);
  assert.equal((await http.delete(`${tracker.url}/unregister/carol`)).status, 204);
  assert.equal(tracker.registry.has("carol"), false);
});

test("entries expire after the ttl unless re-registered", async () => {
  await http.post(`${tracker.url}/register`, { id: "ghost", url: "http://localhost:6009" });
  await waitFor(() => !tracker.registry.has("ghost"), 2000);
  const peers = (await http.get(`${tracker.url}/peers`)).data.peers;
  assert.equal(peers.some((p: { id: string }) => p.id === "ghost"), false);
});

const fakePeer = async (statusFor: (path: string) => number) => {
  const calls: Array<{ method: string; path: string; origin?: string; body: unknown }> = [];
  const app = express();
  app.use(express.json());
  app.all(/.*/, (req, res) => {
    calls.push({ method: req.method, path: req.path, origin: req.headers.origin, body: req.body });
    res.sendStatus(statusFor(req.path));
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = `http://localhost:${(server.address() as { port: number }).port}`;
  return { url, calls, close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
};

test("broadcast relays a route to every other peer with the sender Origin", async () => {
  tracker.registry.clear();
  const a = await fakePeer(() => 202);
  const b = await fakePeer(() => 202);
  const c = await fakePeer(() => 403);
  await http.post(`${tracker.url}/register`, { id: "A", url: a.url });
  await http.post(`${tracker.url}/register`, { id: "B", url: b.url });
  await http.post(`${tracker.url}/register`, { id: "C", url: c.url });
  await http.post(`${tracker.url}/register`, { id: "D", url: "http://localhost:1" });
  const { status, data } = await http.post(`${tracker.url}/broadcast`, { route: "/syn" }, { headers: { Origin: a.url } });
  assert.equal(status, 200);
  const byId = Object.fromEntries(data.results.map((r: any) => [r.id, r.status]));
  assert.deepEqual(byId, { B: 202, C: 403, D: 0 });
  assert.equal(a.calls.length, 0);
  assert.deepEqual(b.calls, [{ method: "POST", path: "/syn", origin: a.url, body: {} }]);
  const health = await http.post(`${tracker.url}/broadcast`, { route: "/health" }, { headers: { Origin: a.url } });
  assert.equal(health.status, 200);
  assert.equal(b.calls[1].method, "GET");
  const body = { action: "message", metadata: { source: a.url, target: "*", timestamp: new Date().toISOString() }, payload: { text: "hi" } };
  await http.post(`${tracker.url}/broadcast`, { route: "/ingress", body }, { headers: { Origin: a.url } });
  assert.deepEqual(b.calls[2].body, body);
  await Promise.all([a.close(), b.close(), c.close()]);
  tracker.registry.clear();
});

test("broadcast validates Origin, route and registration", async () => {
  await http.post(`${tracker.url}/register`, { id: "A", url: "http://localhost:7001" });
  assert.equal((await http.post(`${tracker.url}/broadcast`, { route: "/syn" })).status, 400);
  assert.equal((await http.post(`${tracker.url}/broadcast`, { route: "/nope" }, { headers: { Origin: "http://localhost:7001" } })).status, 400);
  assert.equal((await http.post(`${tracker.url}/broadcast`, { route: "/syn", method: "PUT" }, { headers: { Origin: "http://localhost:7001" } })).status, 400);
  assert.equal((await http.post(`${tracker.url}/broadcast`, { route: "/syn" }, { headers: { Origin: "http://localhost:7999" } })).status, 403);
  tracker.registry.clear();
});
