import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  getAddress,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import type { PrivateKeyAccount } from "viem/accounts";
import type { OnOneClient } from "./api.js";
import { env } from "./config.js";

const LAUNCH_ABI = [
  {
    type: "function",
    name: "launchB20",
    stateMutability: "payable",
    inputs: [
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "salt", type: "bytes32" },
          { name: "quote", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "creator", type: "address" },
          {
            name: "fees",
            type: "tuple",
            components: [
              { name: "creatorBps", type: "uint16" },
              { name: "protocolBps", type: "uint16" },
              { name: "referrerBps", type: "uint16" },
            ],
          },
          { name: "antiSnipeStartBps", type: "uint16" },
          { name: "antiSnipeSeconds", type: "uint32" },
          { name: "creatorDests", type: "address[]" },
          { name: "creatorDestBps", type: "uint16[]" },
          { name: "holderBps", type: "uint16" },
          { name: "coinBurnBps", type: "uint16" },
          { name: "basecatBps", type: "uint16" },
          { name: "dividendToken", type: "address" },
          { name: "launchBuyIn", type: "uint256" },
          { name: "launchBuyMinOut", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
] as const;

const FACTORY_DEPLOY_ABI = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "owner", type: "address" },
      { name: "agentKey", type: "address" },
      { name: "dailyCap", type: "uint256" },
    ],
    outputs: [{ type: "address" }],
  },
] as const;

/** Max ETH the creation fee can be (0.001) plus a safety margin; anything above means a launch buy. */
const CREATION_FEE_WEI = 10n ** 15n;

export type LaunchRequest = {
  name: string;
  symbol: string;
  description?: string;
  website?: string;
  x?: string;
  telegram?: string;
  quote?: string;
  feeTierBps?: number;
  launchBuyEth?: string;
  creatorSplit?: { address: string; bps: number }[];
  agentWallet?: boolean;
  agentWalletBps?: number;
  agentKey?: string;
  dailyCap?: string;
};

type Prepared = {
  intentId: string;
  expiresAt: string;
  token: Address;
  transaction: { chainId: number; from: Address; to: Address; data: Hex; value: string };
  summary: Record<string, unknown>;
  followUp: { purpose: string; transaction: { chainId: number; to: Address; data: Hex; value: string }; agentWallet: Address }[];
};

type Status = { chains: { id: number; router: string | null; agentWalletFactory?: string | null }[] };

/**
 * Never trust a transaction blindly, even from onone.fun: check it goes to the published router,
 * launches exactly what you asked for, from your wallet, for no more ETH than you allowed.
 */
export async function verifyPrepared(api: OnOneClient, req: LaunchRequest, p: Prepared, signer: Address) {
  const status = await api.get<Status>("/api/v1/status");
  const chain = status.chains.find((c) => c.id === p.transaction.chainId);
  if (!chain?.router || getAddress(chain.router) !== getAddress(p.transaction.to)) throw new Error("Refusing: launch tx is not addressed to the published router.");
  if (p.transaction.chainId !== base.id) throw new Error("Refusing: unexpected chain.");
  if (getAddress(p.transaction.from) !== getAddress(signer)) throw new Error("Refusing: tx is for a different wallet.");
  const { args } = decodeFunctionData({ abi: LAUNCH_ABI, data: p.transaction.data });
  const a = args[0];
  const norm = (v: string) => v.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (norm(a.name) !== norm(req.name)) throw new Error(`Refusing: name in tx (${a.name}) differs from your request.`);
  if (a.symbol !== req.symbol.trim().replace(/^\$/, "").toUpperCase()) throw new Error("Refusing: ticker in tx differs from your request.");
  if (getAddress(a.creator) !== getAddress(signer)) throw new Error("Refusing: creator is not your wallet.");
  const maxBuy = req.launchBuyEth ? parseEther(req.launchBuyEth) : 0n;
  if (BigInt(p.transaction.value) > CREATION_FEE_WEI + maxBuy) throw new Error("Refusing: tx spends more ETH than allowed.");
  if (a.launchBuyIn > maxBuy) throw new Error("Refusing: launch buy is larger than requested.");
  const allowed = new Set<string>([getAddress(signer)]);
  for (const s of req.creatorSplit ?? []) allowed.add(getAddress(s.address));
  for (const f of p.followUp) allowed.add(getAddress(f.agentWallet));
  for (const d of a.creatorDests) if (!allowed.has(getAddress(d))) throw new Error(`Refusing: unexpected fee recipient ${d}.`);
  for (const f of p.followUp) {
    if (!chain.agentWalletFactory || getAddress(f.transaction.to) !== getAddress(chain.agentWalletFactory)) {
      throw new Error("Refusing: agent wallet deploy is not addressed to the published factory.");
    }
    if (BigInt(f.transaction.value) !== 0n) throw new Error("Refusing: agent wallet deploy sends ETH.");
    const d = decodeFunctionData({ abi: FACTORY_DEPLOY_ABI, data: f.transaction.data });
    if (getAddress(d.args[1]) !== getAddress(p.token)) throw new Error("Refusing: agent wallet deploy targets another coin.");
    if (getAddress(d.args[2]) !== getAddress(signer)) throw new Error("Refusing: agent wallet owner is not your wallet.");
    if (req.agentKey && getAddress(d.args[3]) !== getAddress(req.agentKey)) throw new Error("Refusing: agent key differs from your request.");
  }
  return a;
}

export async function prepare(api: OnOneClient, req: LaunchRequest): Promise<Prepared> {
  return api.post<Prepared>("/api/v1/agent/launch/prepare", { chainId: 8453, ...req });
}

/** prepare → verify → sign + send → wait → register → (deploy agent wallet). */
export async function launch(
  api: OnOneClient,
  account: PrivateKeyAccount,
  req: LaunchRequest,
  log: (s: string) => void = () => {},
) {
  const rpc = env("RPC_URL") || "https://mainnet.base.org";
  const pub = createPublicClient({ chain: base, transport: http(rpc) });
  const wal = createWalletClient({ chain: base, transport: http(rpc), account });

  log("Preparing launch…");
  const p = await prepare(api, req);
  await verifyPrepared(api, req, p, account.address);
  log(`Checked: ${p.summary.name} ($${p.summary.symbol}) → ${p.token}`);

  const hash = await wal.sendTransaction({
    to: p.transaction.to,
    data: p.transaction.data,
    value: BigInt(p.transaction.value),
    chain: base,
  });
  log(`Sent ${hash}. Waiting for confirmation…`);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error("Launch transaction reverted.");

  let reg: Record<string, unknown> | null = null;
  for (let i = 0; i < 6; i++) {
    try {
      reg = await api.post<Record<string, unknown>>("/api/v1/agent/launch/register", { intentId: p.intentId, tx: hash });
      break;
    } catch (e) {
      if (i === 5) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  let agentWallet: string | null = null;
  for (const f of p.followUp) {
    log("Creating the agent wallet…");
    const h2 = await wal.sendTransaction({ to: f.transaction.to, data: f.transaction.data, value: 0n, chain: base });
    const r2 = await pub.waitForTransactionReceipt({ hash: h2, timeout: 180_000 });
    if (r2.status !== "success") throw new Error("Agent wallet deploy reverted. Retry the follow-up transaction.");
    agentWallet = f.agentWallet;
    await api.post("/api/launch/type", { chainId: 8453, token: p.token }, false).catch(() => null);
  }
  return { tx: hash, token: p.token, agentWallet, ...(reg ?? {}) };
}
