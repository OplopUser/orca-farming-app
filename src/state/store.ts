import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BotRuntimeState, BotState } from "../domain.js";

export const EMPTY_STATE: BotState = {
  activePositionMint: null,
  lastRebalanceAt: null,
  lastCenterPrice: null,
  latestAction: null,
  lastPnlMarkAt: null,
  paused: false,
  pauseReason: null,
  inFlightRebalance: false,
  lastObservedPrice: null,
  lastOraclePrice: null,
  lastOracleAt: null,
  driftTriggerLower: null,
  driftTriggerUpper: null,
  driftDirection: null,
  driftStatus: null,
  pendingRebalance: null,
  positionLowerPrice: null,
  positionUpperPrice: null,
  lastCompoundAt: null,
  totalCompoundCount: 0,
  consecutiveDriftPolls: 0
};

export function createEmptyBotState(): BotState {
  return { ...EMPTY_STATE };
}

export function createEmptyBotRuntimeState(): BotRuntimeState {
  return {
    ...createEmptyBotState(),
    monitoringActive: false,
    lastCycleAt: null
  };
}

export class StateStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<BotRuntimeState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return {
        ...createEmptyBotRuntimeState(),
        ...(JSON.parse(raw) as Partial<BotRuntimeState>)
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyBotRuntimeState();
      }
      throw error;
    }
  }

  async save(state: BotRuntimeState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
