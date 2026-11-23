import { createInterface } from "node:readline";
import { createClient, OnOneError } from "./api.js";
import { apiKeyFromEnv, loadSigner, env } from "./config.js";
import { launch, prepare, type LaunchRequest } from "./launch.js";
import { describe, publicClient, readWallet, resolveWallet, walletAct, type WalletAction } from "./wallet.js";

/**
 * Local MCP server over stdio (newline-delimited JSON-RPC). Same tools as the hosted server,
 * plus `onone_launch`, which signs with YOUR local key — and only when you opt in with
 * ONONE_MCP_ALLOW_SEND=1. A launch buy above ONONE_MCP_MAX_BUY_ETH (default 0) is refused, so a
 * prompt-injected model cannot spend your ETH on its own.
 *
 * Agent-wallet tools (onone_wallet_*) sign with the same local key, also only with
 * ONONE_MCP_ALLOW_SEND=1. Buybacks and payments are refused above ONONE_MCP_MAX_WALLET_SPEND
 * (quote units, default 0 = off) on top of the wallet's own on-chain daily limit. Payments can only
 * go to payees the wallet OWNER approved on-chain, so a model cannot invent a recipient.
 */
const PROTOCOL = "2025-06-18";

/** Tools that sign with the local key and can spend: destructive in MCP terms. */
const SPENDS = new Set(["onone_launch", "onone_wallet_collect", "onone_wallet_buyback", "onone_wallet_pay", "onone_wallet_freeze"]);
const WRITES = new Set([...SPENDS, "onone_prepare_launch", "onone_register_launch"]);
const titleOf = (name: string) =>
  name
    .replace(/^onone_/, "")
    .split("_")
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
const hintsOf = (name: string) => ({
  title: titleOf(name),
  readOnlyHint: !WRITES.has(name),
  destructiveHint: SPENDS.has(name),
  idempotentHint: !WRITES.has(name),
  openWorldHint: true,
});

type Json = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: Json; run: (a: Json) => Promise<unknown> };

const launchProps: Json = {
  name: { type: "string", minLength: 2, maxLength: 32 },
  symbol: { type: "string", minLength: 2, maxLength: 11 },
  description: { type: "string", maxLength: 600 },
  website: { type: "string", maxLength: 200 },
  x: { type: "string", maxLength: 16 },
  telegram: { type: "string", maxLength: 200 },
  quote: { type: "string", maxLength: 12 },
  feeTierBps: { type: "integer", enum: [100, 200, 300] },
  launchBuyEth: { type: "string", maxLength: 24 },
  agentWallet: { type: "boolean" },
  agentWalletBps: { type: "integer", minimum: 100, maximum: 10000 },
  agentKey: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
  dailyCap: { type: "string", maxLength: 32 },
};

const walletRef = {
  type: "object",
  properties: {
    token: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Coin address" },
    wallet: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Agent wallet address (instead of token)" },
  },
} as const;

const ref = (a: Json) => ({
  token: typeof a.token === "string" ? a.token : undefined,
  wallet: typeof a.wallet === "string" ? a.wallet : undefined,
});

async function walletTool(a: Json, action: WalletAction) {
  if (env("MCP_ALLOW_SEND") !== "1") {
    throw new Error("Sending is off. The user must set ONONE_MCP_ALLOW_SEND=1 to let this server sign agent-wallet actions.");
  }
  const account = loadSigner(env("KEY_FILE"));
  if (!account) throw new Error("No local wallet key configured.");
  const pub = publicClient();
  const wallet = await resolveWallet(pub, ref(a));
  const maxSpend = env("MCP_MAX_WALLET_SPEND")?.trim() || "0";
  if ((action.kind === "buyback" || action.kind === "pay") && Number(maxSpend) <= 0) {
    throw new Error("Spending from the agent wallet is off. The user must set ONONE_MCP_MAX_WALLET_SPEND (per action).");
  }
  return walletAct({
    pub,
    wallet,
    account,
    action,
    maxSpend: action.kind === "buyback" || action.kind === "pay" ? maxSpend : undefined,
    log: (m) => process.stderr.write(`[onone] ${m}\n`),
  });
}

export async function runMcp() {
  const api = createClient({ apiKey: apiKeyFromEnv() });
  const q = (v: unknown) => encodeURIComponent(String(v ?? ""));
  const tools: Tool[] = [
    {
      name: "onone_list_coins",
      description: "List live OnOne coins (main feed). Read only.",
      inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 48 } } },
      run: (a) => api.get(`/api/v1/coins?page=1&pageSize=${Math.min(48, Math.max(1, Number(a.limit ?? 20) || 20))}`),
    },
    {
      name: "onone_get_coin",
      description: "Get one OnOne coin. Read only.",
      inputSchema: { type: "object", properties: { chainId: { type: "integer" }, address: { type: "string" } }, required: ["chainId", "address"] },
      run: (a) => api.get(`/api/v1/coin?chainId=${q(a.chainId)}&address=${q(a.address)}`),
    },
    {
      name: "onone_agent_leaderboard",
      description: "Season leaderboard of OnOne agents. Read only.",
      inputSchema: { type: "object", properties: { sort: { type: "string", enum: ["points", "launches", "volume"] } } },
      run: (a) => api.get(`/api/v1/agents?sort=${q(a.sort ?? "points")}&limit=25`),
    },
    {
      name: "onone_me",
      description: "Your agent profile, launches left today and season score.",
      inputSchema: { type: "object", properties: {} },
      run: () => api.get("/api/v1/agent/me", true),
    },
    {
      name: "onone_prepare_launch",
      description: "Screen a coin and return the UNSIGNED launch transaction (nothing is sent).",
      inputSchema: { type: "object", properties: launchProps, required: ["name", "symbol"] },
      run: (a) => prepare(api, a as unknown as LaunchRequest),
    },
    {
      name: "onone_launch",
      description:
        "Launch a coin end to end from the local wallet (prepare, verify, sign, send, register). Only works when the user enabled sending for this MCP server.",
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(launchProps).filter(([k]) => !["agentWallet", "agentWalletBps", "agentKey", "dailyCap"].includes(k)),
        ),
        required: ["name", "symbol"],
      },
      run: async (a) => {
        if (env("MCP_ALLOW_SEND") !== "1") {
          throw new Error("Sending is off. The user must set ONONE_MCP_ALLOW_SEND=1 to let this server sign launches.");
        }
        const maxBuy = Number(env("MCP_MAX_BUY_ETH") ?? "0");
        if (a.launchBuyEth && Number(a.launchBuyEth) > maxBuy) throw new Error(`Launch buy above the ${maxBuy} ETH limit set by the user.`);
        const account = loadSigner(env("KEY_FILE"));
        if (!account) throw new Error("No local wallet key configured.");
        // Only coin details come from the model. Where fees go (splits, agent wallet, its key and
        // limit) is never taken from tool arguments: only from the user's own environment.
        const str = (v: unknown) => (typeof v === "string" ? v : undefined);
        const req: LaunchRequest = {
          name: str(a.name) ?? "",
          symbol: str(a.symbol) ?? "",
          description: str(a.description),
          website: str(a.website),
          x: str(a.x),
          telegram: str(a.telegram),
          quote: str(a.quote),
          feeTierBps: typeof a.feeTierBps === "number" ? a.feeTierBps : undefined,
          launchBuyEth: str(a.launchBuyEth),
        };
        const envKey = env("MCP_AGENT_KEY")?.trim();
        if (envKey) {
          req.agentWallet = true;
          req.agentKey = envKey;
          req.dailyCap = env("MCP_AGENT_DAILY_CAP")?.trim() || "0";
          req.agentWalletBps = Number(env("MCP_AGENT_SHARE_BPS") ?? 5000);
        }
        return launch(api, account, req, (s) => process.stderr.write(`[onone] ${s}\n`));
      },
    },
    {
      name: "onone_wallet_status",
      description: "Status of a coin's AI Agent wallet: balance, fees waiting, today's limit, agent key, owner, pending changes. Read only.",
      inputSchema: walletRef,
      run: async (a) => {
        const pub = publicClient();
        return describe(await readWallet(pub, await resolveWallet(pub, ref(a))));
      },
    },
    {
      name: "onone_wallet_collect",
      description: "Move a coin's waiting creator fees into its AI Agent wallet. Spends nothing but gas.",
      inputSchema: walletRef,
      run: (a) => walletTool(a, { kind: "collect" }),
    },
    {
      name: "onone_wallet_buyback",
      description:
        "From the AI Agent wallet, buy the coin with `amount` of the quote asset and burn it. Signed by the local agent key; counts against the daily limit.",
      inputSchema: {
        type: "object",
        properties: {
          ...walletRef.properties as Json,
          amount: { type: "string", maxLength: 32 },
          slippagePct: { type: "number", minimum: 0.1, maximum: 20 },
          collectFirst: { type: "boolean" },
        },
        required: ["amount"],
      },
      run: (a) =>
        walletTool(a, {
          kind: "buyback",
          amount: String(a.amount ?? ""),
          slippagePct: typeof a.slippagePct === "number" ? a.slippagePct : undefined,
          collectFirst: a.collectFirst === true,
        }),
    },
    {
      name: "onone_wallet_pay",
      description: "From the AI Agent wallet, pay an owner-approved payee. Signed by the local agent key; counts against the daily limit.",
      inputSchema: {
        type: "object",
        properties: { ...walletRef.properties as Json, to: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }, amount: { type: "string", maxLength: 32 } },
        required: ["to", "amount"],
      },
      run: (a) => walletTool(a, { kind: "pay", to: String(a.to ?? ""), amount: String(a.amount ?? "") }),
    },
    {
      name: "onone_wallet_freeze",
      description: "Freeze the AI Agent wallet (emergency stop). Only the owner can unfreeze.",
      inputSchema: walletRef,
      run: (a) => walletTool(a, { kind: "freeze" }),
    },
    {
      name: "onone_register_launch",
      description: "Register a launch you signed yourself: { intentId, tx }.",
      inputSchema: { type: "object", properties: { intentId: { type: "string" }, tx: { type: "string" } }, required: ["intentId", "tx"] },
      run: (a) => api.post("/api/v1/agent/launch/register", { intentId: a.intentId, tx: a.tx }),
    },
  ];

  const out = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg: { id?: string | number; method?: string; params?: Json };
    try {
      msg = JSON.parse(line);
    } catch {
      return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const id = msg.id ?? null;
    if (msg.id === undefined) return; // notification
    try {
      switch (msg.method) {
        case "initialize":
          return out({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "onone-local", version: "0.3.2" } },
          });
        case "ping":
          return out({ jsonrpc: "2.0", id, result: {} });
        case "tools/list":
          return out({ jsonrpc: "2.0", id, result: { tools: tools.map(({ run: _r, ...t }) => ({ ...t, title: titleOf(t.name), annotations: hintsOf(t.name) })) } });
        case "tools/call": {
          // Old base1_* names from saved setups still work.
          const wanted = String(msg.params?.name ?? "").replace(/^base1_/, "onone_");
          const tool = tools.find((t) => t.name === wanted);
          if (!tool) return out({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
          try {
            const res = await tool.run((msg.params?.arguments as Json) ?? {});
            return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(res) }], isError: false } });
          } catch (e) {
            const m = e instanceof OnOneError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : "failed";
            return out({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: m.slice(0, 300) }], isError: true } });
          }
        }
        default:
          return out({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
    } catch {
      return out({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
    }
  });
}
