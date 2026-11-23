import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import type { PrivateKeyAccount } from "viem/accounts";
import { env } from "./config.js";

/**
 * AI Agent wallet operations (collect, buy back + burn, pay, freeze) signed with the agent key on
 * THIS machine. The trust anchor is the AgentWalletFactory address below, not the website: a wallet
 * is only touched if the factory confirms it is a genuine AgentWallet. Every write is simulated
 * first and checked against the wallet's own on-chain rules (agent key, frozen, daily limit, payees).
 */
export const DEFAULT_AGENT_FACTORY: Address = "0xe48853c365b813cb7613a8ecd5ef9c8781cc986f";

const FACTORY_ABI = [
  { type: "function", name: "walletOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isAgentWallet", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;

const WALLET_ABI = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "quote", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "agentKey", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "frozen", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "dailyCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentToday", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balance", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isPayee", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "pendingChange",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "kind", type: "uint8" },
      { name: "target", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "readyAt", type: "uint64" },
    ],
  },
  { type: "function", name: "collectFees", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "buybackAndBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "quoteIn", type: "uint256" },
      { name: "minTokenOut", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  { type: "function", name: "freeze", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

const CHANGE = ["none", "withdraw", "add payee", "raise limit", "hand over ownership"];

export function publicClient(): PublicClient {
  // Batch reads into one multicall and retry politely: the free public RPC rate-limits bursts.
  return createPublicClient({
    chain: base,
    batch: { multicall: true },
    transport: http(env("RPC_URL") || "https://mainnet.base.org", { retryCount: 4, retryDelay: 600 }),
  }) as PublicClient;
}

function factory(): Address {
  const f = env("AGENT_FACTORY")?.trim() || DEFAULT_AGENT_FACTORY;
  if (!isAddress(f, { strict: false })) throw new Error("ONONE_AGENT_FACTORY is not an address.");
  return getAddress(f);
}

/** Find the genuine AgentWallet for a coin (or check a wallet address you pass). */
export async function resolveWallet(pub: PublicClient, ref: { token?: string; wallet?: string }): Promise<Address> {
  const f = factory();
  if (ref.wallet) {
    if (!isAddress(ref.wallet, { strict: false })) throw new Error("--wallet is not an address.");
    const w = getAddress(ref.wallet);
    const ok = await pub.readContract({ address: f, abi: FACTORY_ABI, functionName: "isAgentWallet", args: [w] });
    if (!ok) throw new Error("Refusing: that address is not an AgentWallet from the OnOne factory.");
    return w;
  }
  if (!ref.token || !isAddress(ref.token, { strict: false })) throw new Error("Pass --token <coin address> or --wallet <agent wallet>.");
  const w = await pub.readContract({ address: f, abi: FACTORY_ABI, functionName: "walletOf", args: [getAddress(ref.token)] });
  if (w === zeroAddress) throw new Error("That coin has no AI Agent wallet.");
  return w;
}

export type WalletState = Awaited<ReturnType<typeof readWallet>>;

export async function readWallet(pub: PublicClient, wallet: Address) {
  const r = (fn: (typeof WALLET_ABI)[number]["name"]) =>
    pub.readContract({ address: wallet, abi: WALLET_ABI, functionName: fn as never }) as Promise<unknown>;
  const [token, quote, owner, agentKey, frozen, cap, spent, bal, fees, change] = await Promise.all([
    r("token"),
    r("quote"),
    r("owner"),
    r("agentKey"),
    r("frozen"),
    r("dailyCap"),
    r("spentToday"),
    r("balance"),
    r("pendingFees"),
    r("pendingChange"),
  ]);
  const q = quote as Address;
  const native = q === zeroAddress;
  const [qSym, qDec, tSym] = await Promise.all([
    native ? "ETH" : pub.readContract({ address: q, abi: ERC20_ABI, functionName: "symbol" }),
    native ? 18 : pub.readContract({ address: q, abi: ERC20_ABI, functionName: "decimals" }),
    pub.readContract({ address: token as Address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?"),
  ]);
  const ch = change as readonly [number, Address, bigint, bigint];
  return {
    wallet,
    token: token as Address,
    tokenSymbol: String(tSym),
    quote: q,
    quoteSymbol: String(qSym),
    decimals: Number(qDec),
    owner: owner as Address,
    agentKey: agentKey as Address,
    frozen: Boolean(frozen),
    dailyCap: cap as bigint,
    spentToday: spent as bigint,
    balance: bal as bigint,
    pendingFees: fees as bigint,
    pendingChange: Number(ch[0]) ? { kind: CHANGE[Number(ch[0])] ?? String(ch[0]), target: ch[1], amount: ch[2], readyAt: Number(ch[3]) } : null,
  };
}

/** Human-readable status (amounts in quote units). */
export function describe(s: WalletState) {
  const f = (v: bigint) => formatUnits(v, s.decimals);
  const left = s.dailyCap > s.spentToday ? s.dailyCap - s.spentToday : 0n;
  return {
    agentWallet: s.wallet,
    coin: `$${s.tokenSymbol} ${s.token}`,
    status: s.frozen ? "FROZEN" : "active",
    balance: `${f(s.balance)} ${s.quoteSymbol}`,
    feesWaiting: `${f(s.pendingFees)} ${s.quoteSymbol}`,
    spentToday: `${f(s.spentToday)} / ${f(s.dailyCap)} ${s.quoteSymbol}`,
    leftToday: `${f(left)} ${s.quoteSymbol}`,
    agentKey: s.agentKey,
    owner: s.owner,
    pendingChange: s.pendingChange
      ? {
          ...s.pendingChange,
          amount: s.pendingChange.amount.toString(),
          readyAt: new Date(s.pendingChange.readyAt * 1000).toISOString(),
        }
      : null,
  };
}

export type WalletAction =
  | { kind: "collect" }
  | { kind: "buyback"; amount: string; slippagePct?: number; collectFirst?: boolean }
  | { kind: "pay"; to: string; amount: string }
  | { kind: "freeze" };

/**
 * Check, simulate and (unless dryRun) send one agent-wallet action. `maxSpend` (quote units) is an
 * extra local ceiling on top of the wallet's own daily limit — used by the MCP server.
 */
export async function walletAct(opts: {
  pub: PublicClient;
  wallet: Address;
  account: PrivateKeyAccount | null;
  action: WalletAction;
  dryRun?: boolean;
  maxSpend?: string;
  log?: (s: string) => void;
}) {
  const { pub, wallet, account, action } = opts;
  const log = opts.log ?? (() => {});
  const s = await readWallet(pub, wallet);
  const from = account?.address ?? s.agentKey; // dry run without a key: simulate as the agent key
  if (!opts.dryRun && !account) throw new Error("No wallet key. Set ONONE_PRIVATE_KEY or pass --key-file.");
  const me = getAddress(from);
  const isAgent = me === getAddress(s.agentKey);
  const isOwner = me === getAddress(s.owner);
  const amt = (v: string) => {
    let n: bigint;
    try {
      n = parseUnits(v.trim(), s.decimals);
    } catch {
      throw new Error("Amount is not a number.");
    }
    if (n <= 0n) throw new Error("Amount must be above zero.");
    if (opts.maxSpend !== undefined && n > parseUnits(opts.maxSpend, s.decimals)) {
      throw new Error(`Amount is above the ${opts.maxSpend} ${s.quoteSymbol} per-action limit set by the user.`);
    }
    return n;
  };
  const left = s.dailyCap > s.spentToday ? s.dailyCap - s.spentToday : 0n;
  const fmt = (v: bigint) => `${formatUnits(v, s.decimals)} ${s.quoteSymbol}`;

  let fn: "collectFees" | "buybackAndBurn" | "pay" | "freeze";
  let args: readonly unknown[] = [];
  let collectFirst = false;
  let quoteIn = 0n;
  let slip = 5;

  switch (action.kind) {
    case "collect":
      if (s.pendingFees === 0n) throw new Error("No fees waiting to collect.");
      fn = "collectFees";
      break;
    case "freeze":
      if (!isAgent && !isOwner) throw new Error("Only the agent key or the owner can freeze this wallet.");
      if (s.frozen) throw new Error("Already frozen.");
      fn = "freeze";
      break;
    case "buyback":
    case "pay": {
      if (!isAgent) throw new Error(`Only the agent key (${s.agentKey}) can do this. Loaded key: ${me}.`);
      if (s.frozen) throw new Error("The wallet is frozen. Only the owner can unfreeze it.");
      const n = amt(action.amount);
      if (n > left) throw new Error(`Above today's remaining limit (${fmt(left)}).`);
      const collectable = action.kind === "buyback" && action.collectFirst ? s.pendingFees : 0n;
      if (n > s.balance + collectable) throw new Error(
          `Not enough in the wallet: ${fmt(s.balance)} (+ ${fmt(s.pendingFees)} fees waiting${action.kind === "buyback" ? ", add --collect to use them" : ", run collect first"}).`,
        );
      collectFirst = n > s.balance;
      if (action.kind === "pay") {
        if (!isAddress(action.to, { strict: false })) throw new Error("Payee is not an address.");
        const ok = await pub.readContract({ address: wallet, abi: WALLET_ABI, functionName: "isPayee", args: [getAddress(action.to)] });
        if (!ok) throw new Error("That address is not an approved payee. The owner must add it (48h notice).");
        fn = "pay";
        args = [getAddress(action.to), n];
      } else {
        fn = "buybackAndBurn";
        quoteIn = n;
        slip = Math.min(50, Math.max(0.1, action.slippagePct ?? 5));
      }
      break;
    }
  }

  const rpc = env("RPC_URL") || "https://mainnet.base.org";
  const wal = account ? createWalletClient({ chain: base, transport: http(rpc, { retryCount: 2 }), account }) : null;
  const send = async (f: typeof fn, a: readonly unknown[], label: string) => {
    const sim = await pub.simulateContract({ address: wallet, abi: WALLET_ABI, functionName: f as never, args: a as never, account: me });
    if (opts.dryRun || !wal) {
      const res = sim.result as unknown;
      return { simulated: true, result: res === undefined || res === null ? null : String(res) };
    }
    const hash = await wal.writeContract(sim.request as never);
    log(`${label}: sent ${hash}`);
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== "success") throw new Error(`${label} reverted (${hash}).`);
    return { tx: hash };
  };

  const out: Record<string, unknown> = { wallet, action: action.kind, signer: me, dryRun: Boolean(opts.dryRun) };
  if (collectFirst) {
    if (opts.dryRun) out.note = "Would collect waiting fees first.";
    else out.collect = await send("collectFees", [], "Collect fees");
  }
  if (fn === "buybackAndBurn") {
    if (opts.dryRun && collectFirst) {
      out.result = { simulated: false, note: "Collect first, then simulate. Run collect, then retry the dry run for an exact quote." };
    } else {
      const sim = await pub.simulateContract({ address: wallet, abi: WALLET_ABI, functionName: "buybackAndBurn", args: [quoteIn, 0n], account: me });
      const expected = sim.result as bigint;
      const minOut = (expected * BigInt(Math.round((100 - slip) * 100))) / 10_000n;
      out.expectedBurn = expected.toString();
      out.minBurn = minOut.toString();
      out.spend = fmt(quoteIn);
      out.result = await send("buybackAndBurn", [quoteIn, minOut], "Buy back and burn");
    }
  } else {
    out.result = await send(fn, args, fn);
  }
  out.after = opts.dryRun ? null : describe(await readWallet(pub, wallet));
  return out;
}
