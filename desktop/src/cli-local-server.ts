import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalMiniServer } from "./local-server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.AGENTSCHAT_LOCAL_PORT || 8787);
const host = process.env.AGENTSCHAT_ALLOW_LAN === "1" ? "0.0.0.0" : "127.0.0.1";
const dbPath =
  process.env.AGENTSCHAT_LOCAL_DB ||
  join(process.env.HOME || process.env.USERPROFILE || homedir(), ".agentschat", "desktop", "local-hub.sqlite");

const server = new LocalMiniServer({
  port,
  host,
  dbPath,
  upstreamUrl: process.env.AGENTSCHAT_UPSTREAM_URL,
  staticUiDir: join(__dirname, "..", "ui"),
});

const status = await server.start();
console.log(
  `[agentschat-desktop] Local Mini-Server listening on ${status.httpUrl} (WS: ${status.wsUrl}, Global Identity Authority: ${status.upstreamUrl})`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void server.closeAll().finally(() => process.exit(0));
  });
}
