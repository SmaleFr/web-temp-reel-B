import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import express from "express";
import type { Server } from "node:http";
import { sleep, waitFor } from "./helpers.ts";
import { bootstrap, type Peer, type Registry } from "../src/tracker.ts";

const TRACKER_ORIGIN = "http://tracker.test";

const http = axios.create({ validateStatus: () => true });
const servers: Array<{ close: () => Promise<void> }> = [];

let tracker: { url: string; registry: Registry; close: () => Promise<void> };

const listen = async (app: express.Express) => {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const url = `http://localhost:${(server.address() as { port: number }).port}`;

  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return { url, close };
};

before(async () => {
  const app = bootstrap(
    axios.create({ headers: { Origin: TRACKER_ORIGIN }, timeout: 1000 }),
  );
  tracker = { ...(await listen(app)), registry: app.locals.registry };
});

after(() => tracker.close());

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  tracker.registry.clear();
});

const byId = (peers: Peer[]) =>
  [...peers].sort((a, b) => a.id.localeCompare(b.id));

const fakeReceiver = async () => {
  const app = express();
  app.use(express.json());

  const pushes: Array<{ origin?: string; body: Peer[] }> = [];

  app.post("/register", (req, res) => {
    pushes.push({ origin: req.headers.origin, body: req.body });
    res.sendStatus(204);
  });

  const { url, close } = await listen(app);

  servers.push({ close });

  return { url, pushes, last: () => pushes.at(-1)?.body ?? [] };
};

test("register stores the peer", async () => {
  const { status } = await http.post(`${tracker.url}/register`, {
    id: "alice",
    url: "http://localhost:1",
  });

  assert.equal(status, 204);

  assert.deepEqual(tracker.registry.get("alice"), {
    id: "alice",
    url: "http://localhost:1",
  });
});

test("malformed JSON is rejected", async () => {
  const { status } = await http.post(`${tracker.url}/register`, "{oops", {
    headers: { "Content-Type": "application/json" },
  });

  assert.equal(status, 400);
});

test("register pushes the full peer list to every registered server", async () => {
  const server_A = await fakeReceiver();
  const server_B = await fakeReceiver();

  await http.post(`${tracker.url}/register`, { id: "A", url: server_A.url });
  await waitFor(() => server_A.pushes.length === 1);
  assert.deepEqual(server_A.last(), [{ id: "A", url: server_A.url }]);
  assert.equal(server_A.pushes[0].origin, TRACKER_ORIGIN);

  await http.post(`${tracker.url}/register`, { id: "B", url: server_B.url });
  const expected = byId([
    { id: "A", url: server_A.url },
    { id: "B", url: server_B.url },
  ]);
  await waitFor(
    () => server_A.pushes.length === 2 && server_B.pushes.length === 1,
  );
  assert.deepEqual(byId(server_A.last()), expected);
  assert.deepEqual(byId(server_B.last()), expected);
});

test("unregister removes the peer and pushes the list to the remaining servers", async () => {
  const server_A = await fakeReceiver();
  await http.post(`${tracker.url}/register`, { id: "A", url: server_A.url });

  const server_B = await fakeReceiver();
  await http.post(`${tracker.url}/register`, { id: "B", url: server_B.url });

  await waitFor(
    () => server_A.pushes.length === 2 && server_B.pushes.length === 1,
  );
  const { status } = await http.delete(`${tracker.url}/unregister/B`);

  assert.equal(status, 204);
  assert.equal(tracker.registry.has("B"), false);

  await waitFor(() => server_A.pushes.length === 3);
  assert.deepEqual(server_A.last(), [{ id: "A", url: server_A.url }]);
  await sleep(100);
  assert.equal(server_B.pushes.length, 1);
});

test("unregister of an unknown id answers 204 without pushing", async () => {
  const server_A = await fakeReceiver();
  await http.post(`${tracker.url}/register`, { id: "A", url: server_A.url });

  await waitFor(() => server_A.pushes.length === 1);
  const { status } = await http.delete(`${tracker.url}/unregister/ghost`);
  assert.equal(status, 204);

  await sleep(100);
  assert.equal(server_A.pushes.length, 1);
});

test("an unreachable server does not block the push to the others", async () => {
  const server_A = await fakeReceiver();
  await http.post(`${tracker.url}/register`, {
    id: "down",
    url: "http://localhost:1",
  });

  await http.post(`${tracker.url}/register`, { id: "A", url: server_A.url });

  await waitFor(() => server_A.pushes.length >= 1);
  assert.deepEqual(
    byId(server_A.pushes[0].body),
    byId([
      { id: "A", url: server_A.url },
      { id: "down", url: "http://localhost:1" },
    ]),
  );
});

test("a server that fails every retry is removed and the others are told", async () => {
  const server_A = await fakeReceiver();

  await http.post(`${tracker.url}/register`, { id: "A", url: server_A.url });
  await waitFor(() => server_A.pushes.length === 1);

  await http.post(`${tracker.url}/register`, {
    id: "down",
    url: "http://localhost:1",
  });

  await waitFor(() => !tracker.registry.has("down"), 5000);
  await waitFor(
    () => server_A.last().every((peer) => peer.id !== "down"),
    5000,
  );
  assert.deepEqual(server_A.last(), [{ id: "A", url: server_A.url }]);
});
