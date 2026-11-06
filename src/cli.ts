import readline from "node:readline";
import { setLogOutput } from "./log.ts";
import type { Node, SendResult } from "./node.ts";

const HELP = `commandes :
  /all <texte>        message à tous les pairs connectés
  /msg <id> <texte>   message privé
  /who                pairs en ligne et connexions établies
  /quit               quitter le réseau
  <texte>             équivalent à /all`;

const describeResult = (result: SendResult, peer: string) => {
  if (result === "delivered") return "[livré]";
  if (result === "queued") return "[en file] il sera livré à la reconnexion";
  return `[erreur] ${peer} est inconnu`;
};

const listOrNobody = (names: string[]) => names.join(", ") || "personne";

export const attachCli = (node: Node) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${node.id}> ` });
  let closing = false;

  const print = (line: string) => {
    if (closing) {
      console.log(line);
      return;
    }
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  };

  const quit = async () => {
    closing = true;
    rl.close();
    await node.stop();
    process.exit(0);
  };

  const sendToAll = async (text: string) => {
    const reached = await node.sendToAll(text);
    print(`[livré] ${reached} pair(s)`);
  };

  const commands: Record<string, (args: string[]) => unknown> = {
    "/help": () => print(HELP),
    "/quit": quit,
    "/who": () => {
      print(`en ligne : ${listOrNobody(node.online())}`);
      print(`connectés : ${listOrNobody(node.connected())}`);
    },
    "/all": async (words) => {
      if (words.length === 0) return print(HELP);
      await sendToAll(words.join(" "));
    },
    "/msg": async ([peer, ...words]) => {
      if (!peer || words.length === 0) return print(HELP);
      print(describeResult(await node.sendTo(peer, words.join(" ")), peer));
    },
  };

  setLogOutput(print);

  node.events.on("chat", ({ kind, from, text }) => print(`${kind === "broadcast" ? "[tous]" : "[privé]"} ${from} : ${text}`));
  node.events.on("presence", (id, status) => print(`[présence] ${id} ${status === "online" ? "en ligne" : "hors ligne"}`));

  rl.on("line", async (input) => {
    const line = input.trim();
    if (line.startsWith("/")) {
      const [name, ...args] = line.split(/\s+/);
      await (commands[name] ?? commands["/help"])(args);
    } else if (line) {
      await sendToAll(line);
    }
    if (!closing) rl.prompt();
  });

  rl.on("SIGINT", quit);
  print(`nœud ${node.id} prêt sur ${node.url}, tape /help`);
};
