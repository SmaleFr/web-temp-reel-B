import express, { type Express } from "express";
import { type AxiosInstance } from "axios";
import { logger } from "./logger.ts";
import { handleErrors } from "./http.ts";

export type Peer = { id: string; url: string };
export type Registry = Map<string, Peer>;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const bootstrap = (axiosInstance: AxiosInstance): Express => {
  const app = express();
  const registry: Registry = new Map();

  app.use(express.json());
  app.locals.registry = registry;

  const pushTo = async (target: Peer, list: Peer[]) => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axiosInstance.post(`${target.url}/register`, list);
        return true;
      } catch (error) {
        logger.warn("Cannot push peers", { id: target.id, attempt, error });
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    return false;
  };

  const pushPeers = async () => {
    const list = [...registry.values()];

    const results = await Promise.all(
      list.map((target) => pushTo(target, list)),
    );

    let removed = false;
    list.forEach((target, index) => {
      if (!results[index] && registry.delete(target.id)) {
        logger.warn("Peer removed (unreachable)", { id: target.id });
        removed = true;
      }
    });

    logger.info("Peer list pushed", { servers: list.length });

    if (removed) {
      await pushPeers();
    }
  };

  app.post("/register", (req, res) => {
    const { id, url } = req.body;

    registry.set(id, { id, url });

    logger.info("Peer registered", { id, url });
    pushPeers();

    res.sendStatus(204);
  });

  app.delete("/unregister/:id", (req, res) => {
    const { id } = req.params;

    if (registry.delete(id)) {
      logger.info("Peer unregistered", { id });
      pushPeers();
    }

    res.sendStatus(204);
  });

  app.use(handleErrors);

  return app;
};
