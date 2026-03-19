import { loadConfig } from "./config.js";
import { OrcaClient } from "./clients/orcaClient.js";
import { createLogger } from "./logger.js";
import { RebalancerService, type RunMode } from "./services/rebalancer.js";
import { StateStore } from "./state/store.js";

async function main() {
  const modeArg = process.argv[2];
  if (!modeArg || !["run", "dry-run", "rebalance-now"].includes(modeArg)) {
    throw new Error("Usage: tsx src/index.ts <run|dry-run|rebalance-now>");
  }

  const mode = modeArg as RunMode;
  const config = loadConfig();
  const logger = createLogger(config);
  const stateStore = new StateStore(config.BOT_STATE_FILE);
  const orcaClient = new OrcaClient(config);

  await orcaClient.init();

  const service = new RebalancerService(config, logger, stateStore, orcaClient);
  await service.run(mode);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
