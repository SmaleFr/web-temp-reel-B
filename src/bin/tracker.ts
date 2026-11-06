import { startTracker } from "../tracker.ts";
import { readArgs } from "./args.ts";

const { values } = readArgs();
const tracker = await startTracker({ port: Number(values.port ?? 4000) });

const shutdown = async () => {
  await tracker.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
