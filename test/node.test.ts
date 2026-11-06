import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";
import { EventEmitter } from "node:events";
import { collect, nextEvent, sleep, waitFor } from "./helpers.ts";
import { startTracker } from "../src/tracker.ts";
import { startNode, type Chat, type NodeEvents } from "../src/node.ts";

type Node = Awaited<ReturnType<typeof startNode>>;

const http = axios.create({ validateStatus: () => true });
let tracker: Awaited<ReturnType<typeof startTracker>>;
let nodes: Node[] = [];

const fast = {
  timeout: 1000,
  retries: 2,
  baseDelay: 20,
  maxDelay: 200,
  healthInterval: 100,
  maxMissedPongs: 3,
  discoverInterval: 100,
  registerInterval: 200,
};

const spawn = async (id: string, port = 0, events?: EventEmitter<NodeEvents>) => {
  const node = await startNode({ id, port, trackerUrl: tracker.url, events, ...fast });
  nodes.push(node);
  return node;
};

const mesh = async (...ids: string[]) => {
  const list: Node[] = [];
  for (const id of ids) list.push(await spawn(id));
  await waitFor(() => list.every((n) => n.connected().filter((c) => ids.includes(c)).length === ids.length - 1), 5000);
  return list;
};

const ingress = (source: string, target = "*") => ({
  action: "message",
  metadata: { source, target, timestamp: new Date().toISOString() },
  payload: { text: "x" },
});

before(async () => {
  tracker = await startTracker({ port: 0, ttl: 1000, timeout: 1000 });
});

after(() => tracker.stop());

afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop({ graceful: false })));
  nodes = [];
  tracker.registry.clear();
});

test("a new node registers and handshakes with everyone through a /syn broadcast", async () => {
  const [alice, bob, carol] = await mesh("alice", "bob", "carol");
  assert.equal(tracker.registry.get("alice")?.url, alice.url);
  assert.deepEqual(alice.connected().sort(), ["bob", "carol"]);
  assert.deepEqual(bob.connected().sort(), ["alice", "carol"]);
  assert.deepEqual(carol.connected().sort(), ["alice", "bob"]);
});

test("routes answer with the protocol A status codes", async () => {
  const [alice] = await mesh("alice");
  const eve = { headers: { Origin: "http://localhost:1" } };
  assert.equal((await http.get(`${alice.url}/health`)).status, 204);
  assert.equal((await http.get(`${alice.url}/health`, eve)).status, 202);
  for (const route of ["/syn", "/syn-ack", "/ack", "/forget", "/ingress", "/pong"]) {
    assert.equal((await http.post(`${alice.url}${route}`, {})).status, 400, route);
  }
  assert.equal((await http.post(`${alice.url}/syn-ack`, {}, eve)).status, 403);
  assert.equal((await http.post(`${alice.url}/ack`, {}, eve)).status, 403);
  assert.equal((await http.post(`${alice.url}/forget`, {}, eve)).status, 403);
  assert.equal((await http.post(`${alice.url}/pong`, {}, eve)).status, 403);
  assert.equal((await http.post(`${alice.url}/ingress`, ingress("http://localhost:1"), eve)).status, 403);
  assert.equal((await http.post(`${alice.url}/syn`, {}, eve)).status, 202);
});

test("ingress is deduplicated with 208 and validated with 400", async () => {
  const [alice, bob] = await mesh("alice", "bob");
  const headers = { headers: { Origin: bob.url } };
  const body = ingress(bob.url, alice.url);
  assert.equal((await http.post(`${alice.url}/ingress`, body, headers)).status, 201);
  assert.equal((await http.post(`${alice.url}/ingress`, body, headers)).status, 208);
  assert.equal((await http.post(`${alice.url}/ingress`, { action: "x" }, headers)).status, 400);
});

test("broadcast goes through the tracker to every connected peer", async () => {
  const [alice, bob, carol] = await mesh("alice", "bob", "carol");
  const aliceChats = collect<[Chat]>(alice.events, "chat");
  const bobGets = nextEvent<[Chat]>(bob.events, "chat");
  const carolGets = nextEvent<[Chat]>(carol.events, "chat");
  assert.equal(await alice.sendToAll("salut"), 2);
  const [[toBob], [toCarol]] = await Promise.all([bobGets, carolGets]);
  assert.deepEqual(toBob, { kind: "broadcast", from: "alice", text: "salut" });
  assert.equal(toCarol.text, "salut");
  await sleep(100);
  assert.equal(aliceChats.length, 0);
});

test("private message goes directly to its target only", async () => {
  const [alice, bob, carol] = await mesh("alice", "bob", "carol");
  const carolChats = collect<[Chat]>(carol.events, "chat");
  const bobGets = nextEvent<[Chat]>(bob.events, "chat");
  assert.deepEqual(await alice.sendTo("bob", "secret"), "delivered");
  assert.deepEqual((await bobGets)[0], { kind: "private", from: "alice", text: "secret" });
  await sleep(100);
  assert.equal(carolChats.length, 0);
  assert.deepEqual(await alice.sendTo("nobody", "?"), "unknown");
});

test("presence follows the tracker registrations", async () => {
  const [alice] = await mesh("alice", "bob");
  const presences = collect<[string, string]>(alice.events, "presence");
  const carol = await spawn("carol");
  await waitFor(() => presences.some(([id, s]) => id === "carol" && s === "online"));
  await carol.stop();
  await waitFor(() => presences.some(([id, s]) => id === "carol" && s === "offline"));
  assert.deepEqual(alice.online(), ["bob"]);
});

test("forget is sent on quit", async () => {
  const [alice, bob] = await mesh("alice", "bob");
  const forgotten = nextEvent<[string, string]>(alice.events, "forgotten");
  await bob.stop();
  assert.deepEqual(await forgotten, [bob.url, "remote forget"]);
  assert.deepEqual(alice.connected(), []);
});

test("keep-alive forgets a crashed peer", async () => {
  const [alice, bob] = await mesh("alice", "bob");
  const forgotten = nextEvent<[string, string]>(alice.events, "forgotten", 5000);
  await bob.stop({ graceful: false });
  assert.equal((await forgotten)[0], bob.url);
});

test("messages for a disconnected peer are queued then flushed in order", async () => {
  const [alice, bob] = await mesh("alice", "bob");
  const port = Number(new URL(bob.url).port);
  await bob.stop();
  await waitFor(() => !alice.connected().includes("bob"));
  for (const text of ["un", "deux", "trois"]) assert.deepEqual(await alice.sendTo("bob", text), "queued");
  const events = new EventEmitter<NodeEvents>();
  const chats = collect<[Chat]>(events, "chat");
  await spawn("bob", port, events);
  await waitFor(() => chats.length === 3, 5000);
  assert.deepEqual(chats.map(([c]) => c.text), ["un", "deux", "trois"]);
  assert.equal(alice.pendingMessages(), 0);
});

test("a crashed peer that restarts is reconnected", async () => {
  const [alice, bob] = await mesh("alice", "bob");
  const port = Number(new URL(bob.url).port);
  await bob.stop({ graceful: false });
  const next = await spawn("bob", port);
  await waitFor(() => alice.connected().includes("bob") && next.connected().includes("alice"), 5000);
  const received = nextEvent<[Chat]>(next.events, "chat");
  assert.deepEqual(await alice.sendTo("bob", "re"), "delivered");
  assert.equal((await received)[0].text, "re");
});
