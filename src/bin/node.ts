import { attachCli } from "../cli.ts";
import { startNode } from "../node.ts";
import { isValidId } from "../protocol.ts";
import { readArgs } from "./args.ts";

const { values, positionals } = readArgs();
const id = values.id ?? positionals[0];

if (!isValidId(id)) {
  console.error("usage : npm run node -- <id> [--port 6001]  (lettres, chiffres, _ ou -, 32 caractères max)");
  process.exit(1);
}

const node = await startNode({
  id,
  port: Number(values.port ?? 0),
  publicUrl: values.url,
  trackerUrl: values.tracker,
});

attachCli(node);
