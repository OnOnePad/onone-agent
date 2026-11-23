import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * Local config: ~/.config/onone/agent.json (owner-only permissions). Holds the API key and
 * wallet address. The wallet's private key is NEVER written here: it is read from the
 * ONONE_PRIVATE_KEY environment variable or a key file you point to with --key-file.
 */
export type LocalConfig = { apiKey?: string; wallet?: string; baseUrl?: string };

/** Reads ONONE_<name>, then the old BASE1_<name> so existing setups keep working. */
export function env(name: string): string | undefined {
  return process.env[`ONONE_${name}`] ?? process.env[`BASE1_${name}`];
}

function configDir(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function configPath(): string {
  return join(configDir(), "onone", "agent.json");
}

/** Config saved by @base1/agent before the rename. Read only; the next save writes the new path. */
function legacyConfigPath(): string {
  return join(configDir(), "base1", "agent.json");
}

export function loadConfig(): LocalConfig {
  let p = configPath();
  if (!existsSync(p)) p = legacyConfigPath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LocalConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: LocalConfig) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* windows */
  }
}

export function apiKeyFromEnv(): string | undefined {
  return env("API_KEY")?.trim() || loadConfig().apiKey;
}

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

/** Load the signing account from env or a key file. Refuses world-readable key files on unix. */
export function loadSigner(keyFile?: string): PrivateKeyAccount | null {
  let raw = env("PRIVATE_KEY")?.trim();
  if (!raw && keyFile) {
    if (process.platform !== "win32") {
      const mode = statSync(keyFile).mode & 0o077;
      if (mode !== 0) throw new Error(`Key file ${keyFile} is readable by other users. Run: chmod 600 ${keyFile}`);
    }
    raw = readFileSync(keyFile, "utf8").trim();
  }
  if (!raw) return null;
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!HEX_KEY.test(key)) throw new Error("Private key must be 32 bytes of hex.");
  return privateKeyToAccount(key as `0x${string}`);
}
