import os from "node:os";
import path from "node:path";
import { AGENT_HOST, AGENT_PORT } from "./constants";
import { startServer } from "./server";

const version = process.env.npm_package_version || "0.1.0";
const userDataDir =
  process.env.PRINT_AGENT_USER_DATA ||
  path.join(os.homedir(), ".pos-print-agent");

startServer({
  host: AGENT_HOST,
  port: AGENT_PORT,
  version,
  userDataDir,
})
  .then((status) => {
    console.log(
      `OrderX Print Agent listening on http://${status.host}:${status.port}`,
    );
    console.log(`Health: http://${status.host}:${status.port}/health`);
  })
  .catch((error: unknown) => {
    console.error("Failed to start print agent service", error);
    process.exit(1);
  });
