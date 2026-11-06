import { parseArgs } from "node:util";

export const readArgs = () =>
  parseArgs({
    allowPositionals: true,
    options: {
      id: { type: "string" },
      port: { type: "string", short: "p" },
      url: { type: "string" },
      tracker: { type: "string", short: "t", default: process.env.TRACKER_URL ?? "http://localhost:4000" },
    },
  });
