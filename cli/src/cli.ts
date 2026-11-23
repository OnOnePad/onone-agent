#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { OnOneError, createClient } from "./api.js";
import { apiKeyFromEnv, configPath, loadConfig, loadSigner, saveConfig } from "./config.js";
import { launch, prepare, verifyPrepared, type LaunchRequest } from "./launch.js";
import { runMcp } from "./mcp.js";
import { describe, publicClient, readWallet, resolveWallet, walletAct, type WalletAction } from "./wallet.js";

const HELP = `onone-agent — launch and track coins on OnOne from your own wallet

Wallet key: set ONONE_PRIVATE_KEY in your environment, or pass --key-file <path> (chmod 600).
The key never leaves this machine. Only the API key is stored, in ${configPath()}.

Commands
  login --name <agent name>          Sign once, create an API key, save it locally
  whoami                             Profile, launches left today, score
  launch --name <n> --symbol <s>     Prepare, check, sign, send and register a launch
        [--description <t>] [--quote ETH] [--fee 100|200|300] [--buy <eth>]
        [--split 0xA:5000,0xB:5000] [--agent-wallet --agent-key 0x… --daily-cap 0.05 --agent-share 5000]
        [--dry-run] [--yes]
  logo --token 0x… --file logo.png   Upload a logo (within 24h of launch)
  consent --agent 0x…                Let an agent send creator fees to your wallet
  keys | revoke <keyId>              List or revoke API keys
  leaderboard [points|launches|volume]
  mcp                                Run the local MCP server (stdio)

AI Agent wallet (signed by the agent key on this machine; checked against the wallet's on-chain rules)
  wallet status  --token 0x…         Balance, fees waiting, today's limit, agent key, owner
  wallet collect --token 0x…         Move waiting fees into the agent wallet (anyone can)
  wallet buyback --token 0x… --amount <n> [--slippage 5] [--collect]
                                     Buy the coin with <n> of the quote asset and burn it
  wallet pay     --token 0x… --to 0x… --amount <n>   Pay an owner-approved payee
  wallet freeze  --token 0x…         Stop the agent (only the owner can unfreeze)
        Use --wallet 0x… instead of --token to name the agent wallet directly. Add --dry-run to
        simulate only, --yes to skip the confirmation.
`;

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[k] = next;
        i++;
      } else out[k] = true;
    } else pos.push(a);
  }
  return { flags: out, pos };
}

const s = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

async function confirm(q: string) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = args(rest);
  const keyFile = s(flags["key-file"]);
  const api = createClient({ apiKey: apiKeyFromEnv(), baseUrl: loadConfig().baseUrl });
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case "login": {
      const account = loadSigner(keyFile);
      if (!account) throw new Error("No wallet key. Set ONONE_PRIVATE_KEY or pass --key-file.");
      const ch = await api.post<{ token: string; message: string }>(
        "/api/v1/agent/auth/challenge",
        { wallet: account.address, purpose: "create_key" },
        false,
      );
      const signature = await account.signMessage({ message: ch.message });
      const res = await api.post<{ apiKey: string; agent: { name: string; slug: string } }>(
        "/api/v1/agent/keys",
        { token: ch.token, signature, name: s(flags.name) ?? "Agent", label: "cli" },
        false,
      );
      saveConfig({ ...loadConfig(), apiKey: res.apiKey, wallet: account.address });
      console.log(`Logged in as ${res.agent.name} (${account.address}). Key saved to ${configPath()}.`);
      return;
    }
    case "whoami":
      return print(await api.get("/api/v1/agent/me", true));
    case "launch": {
      const account = loadSigner(keyFile);
      const req: LaunchRequest = {
        name: s(flags.name) ?? "",
        symbol: s(flags.symbol) ?? "",
        description: s(flags.description),
        website: s(flags.website),
        x: s(flags.x),
        telegram: s(flags.telegram),
        quote: s(flags.quote),
        feeTierBps: flags.fee ? Number(flags.fee) : undefined,
        launchBuyEth: s(flags.buy),
        creatorSplit: s(flags.split)
          ?.split(",")
          .map((p) => {
            const [address, bps] = p.split(":");
            return { address: address ?? "", bps: Number(bps) };
          }),
        agentWallet: flags["agent-wallet"] === true ? true : undefined,
        agentKey: s(flags["agent-key"]),
        dailyCap: s(flags["daily-cap"]),
        agentWalletBps: flags["agent-share"] ? Number(flags["agent-share"]) : undefined,
      };
      if (!req.name || !req.symbol) throw new Error("--name and --symbol are required.");
      if (flags["dry-run"]) {
        const p = await prepare(api, req);
        if (account) await verifyPrepared(api, req, p, account.address);
        return print({ ...p, note: "Dry run: nothing was signed or sent." });
      }
      if (!account) throw new Error("No wallet key. Set ONONE_PRIVATE_KEY or pass --key-file.");
      if (!flags.yes) {
        const buy = req.launchBuyEth ? ` with a ${req.launchBuyEth} ETH launch buy` : "";
        if (!(await confirm(`Launch ${req.name} ($${req.symbol.toUpperCase()}) from ${account.address}${buy}?`))) return;
      }
      return print(await launch(api, account, req, (m) => console.error(m)));
    }
    case "logo": {
      const token = s(flags.token);
      const file = s(flags.file);
      if (!token || !file) throw new Error("--token and --file are required.");
      if (statSync(file).size > 1024 * 1024) throw new Error("Logo must be under 1 MB.");
      const form = new FormData();
      form.set("token", token);
      form.set("logo", new Blob([readFileSync(file)]), basename(file));
      return print(await api.upload("/api/v1/agent/launch/art", form));
    }
    case "consent": {
      const account = loadSigner(keyFile);
      const agent = s(flags.agent);
      if (!account || !agent) throw new Error("--agent and a wallet key are required.");
      const action = flags.revoke ? "revoke" : "grant";
      const ch = await api.post<{ token: string; message: string }>(
        "/api/v1/agent/consent/challenge",
        { recipient: account.address, agent, action },
        false,
      );
      const signature = await account.signMessage({ message: ch.message });
      return print(await api.post("/api/v1/agent/consent", { token: ch.token, signature, action }, false));
    }
    case "keys":
      return print(await api.get("/api/v1/agent/keys", true));
    case "revoke":
      if (!pos[0]) throw new Error("Usage: revoke <keyId>");
      return print(await api.del(`/api/v1/agent/keys?id=${encodeURIComponent(pos[0])}`));
    case "leaderboard":
      return print(await api.get(`/api/v1/agents?sort=${encodeURIComponent(pos[0] ?? "points")}&limit=25`));
    case "mcp":
      return runMcp();
    case "wallet": {
      const sub = pos[0] ?? "status";
      const pub = publicClient();
      const wallet = await resolveWallet(pub, { token: s(flags.token), wallet: s(flags.wallet) });
      if (sub === "status") return print(describe(await readWallet(pub, wallet)));
      let action: WalletAction;
      if (sub === "collect") action = { kind: "collect" };
      else if (sub === "freeze") action = { kind: "freeze" };
      else if (sub === "buyback") {
        const amount = s(flags.amount);
        if (!amount) throw new Error("--amount is required.");
        action = { kind: "buyback", amount, slippagePct: flags.slippage ? Number(flags.slippage) : undefined, collectFirst: flags.collect === true };
      } else if (sub === "pay") {
        const amount = s(flags.amount);
        const to = s(flags.to);
        if (!amount || !to) throw new Error("--to and --amount are required.");
        action = { kind: "pay", to, amount };
      } else throw new Error("Unknown wallet command. Use status, collect, buyback, pay or freeze.");
      const account = loadSigner(keyFile);
      const dryRun = flags["dry-run"] === true;
      if (!dryRun) {
        if (!account) throw new Error("No wallet key. Set ONONE_PRIVATE_KEY or pass --key-file.");
        if (!flags.yes) {
          const st = describe(await readWallet(pub, wallet));
          const what =
            action.kind === "buyback"
              ? `buy back and burn ${st.coin.split(" ")[0]} with ${action.amount}`
              : action.kind === "pay"
                ? `pay ${action.amount} to ${action.to}`
                : action.kind;
          if (!(await confirm(`${what} from agent wallet ${wallet} (left today: ${st.leftToday}) signed by ${account.address}?`))) return;
        }
      }
      return print(await walletAct({ pub, wallet, account, action, dryRun, log: (m) => console.error(m) }));
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  const short = (e as { shortMessage?: string; details?: string } | null) ?? {};
  const m =
    e instanceof OnOneError
      ? `${e.code}: ${e.message}`
      : short.shortMessage
        ? `${short.shortMessage}${short.details ? ` (${short.details})` : ""}`
        : e instanceof Error
          ? e.message
          : String(e);
  console.error(`Error: ${m}`);
  process.exit(1);
});
