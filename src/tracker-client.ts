import axios from "axios";
import type { Logger } from "./log.ts";
import type { BroadcastResult, Peer } from "./tracker.ts";

export const createTrackerClient = (trackerUrl: string, log: Logger) => {
  const http = axios.create({ baseURL: trackerUrl, timeout: 20_000 });
  let reachable = true;

  return {
    async register(peer: Peer) {
      try {
        await http.post("/register", peer);
        if (!reachable) log.info("tracker reachable again");
        reachable = true;
      } catch (error) {
        if (reachable) log.warn(`tracker unreachable (${(error as Error).message})`);
        reachable = false;
      }
    },

    async unregister(id: string) {
      await http.delete(`/unregister/${encodeURIComponent(id)}`).catch(() => undefined);
    },

    async peers() {
      const { data } = await http.get<{ peers: Peer[] }>("/peers");
      return data.peers;
    },

    async broadcast(origin: string, route: string, body?: object) {
      const { data } = await http.post<{ results: BroadcastResult[] }>("/broadcast", { route, body }, { headers: { Origin: origin } });
      return data.results;
    },
  };
};
