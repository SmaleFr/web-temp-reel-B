import express, { type Express } from "express";
import { type AxiosInstance } from "axios";
import { logger } from "./logger.ts";
import { handleErrors } from "./http.ts";

export type Peer = { id: string; url: string };
export type Registry = Map<string, Peer>;

export const bootstrap = (axiosInstance: AxiosInstance): Express => {
  const app = express();
  const registry: Registry = new Map();

  app.use(express.json());
  app.locals.registry = registry;

  const pushPeers = async () => {
    const list = [...registry.values()];

    await Promise.all(
      list.map(async (target) => {
        try {
          await axiosInstance.post(`${target.url}/register`, list);
        } catch (error) {
          logger.warn("Cannot push peers", { id: target.id, error });
        }
      }),
    );

    logger.info("Peer list pushed", { servers: list.length });
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
