import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { envSchema } from "../src/config.js";

function parseEnvFile(raw: string) {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    entries[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return entries;
}

describe(".env.example", () => {
  it("matches the code defaults in src/config.ts for every variable it sets", async () => {
    const example = parseEnvFile(await readFile(".env.example", "utf8"));
    const defaults = envSchema.parse({
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      BOT_WALLET_KEYPAIR_PATH: "./wallet.json",
      ORCA_WHIRLPOOL_ADDRESS: "placeholder"
    }) as Record<string, unknown>;
    const parsedExample = envSchema.parse({ ...example, ORCA_WHIRLPOOL_ADDRESS: "placeholder" }) as Record<string, unknown>;

    for (const key of Object.keys(example)) {
      if (!(key in defaults) || ["SOLANA_RPC_URL", "BOT_WALLET_KEYPAIR_PATH", "ORCA_WHIRLPOOL_ADDRESS"].includes(key)) {
        continue;
      }
      expect({ key, value: parsedExample[key] }).toEqual({ key, value: defaults[key] });
    }
  });

  it("lists every variable the config schema reads", async () => {
    const example = parseEnvFile(await readFile(".env.example", "utf8"));
    for (const key of Object.keys(envSchema.shape)) {
      expect(example, key).toHaveProperty(key);
    }
  });
});
