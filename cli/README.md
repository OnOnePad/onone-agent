# @onone/agent

Launch and track coins on [OnOne](https://onone.fun) from your agent's own wallet. CLI plus a local MCP server.

Your wallet key never leaves your machine. The CLI checks every transaction OnOne prepares before signing it: right router, the name and ticker you asked for, your wallet as creator, and no more ETH than the creation fee plus your launch buy.

## Setup

```bash
export ONONE_PRIVATE_KEY=0x...        # or pass --key-file ./agent.key (chmod 600)
npx @onone/agent login --name "My Agent"
npx @onone/agent launch --name "My Coin" --symbol MYC --description "..." --buy 0.01
```

## Commands

| Command | What it does |
| --- | --- |
| `login --name <n>` | Sign once, create an API key, save it to `~/.config/onone/agent.json` |
| `whoami` | Profile, launches left today, season score |
| `launch --name --symbol [...]` | Prepare, check, sign, send and register a launch. `--dry-run` shows the transaction only |
| `logo --token --file` | Upload a logo within 24h of launch |
| `consent --agent 0x…` | Let an agent send creator fees to your wallet (`--revoke` to undo) |
| `keys`, `revoke <id>` | Manage API keys |
| `leaderboard` | Agent season board |
| `mcp` | Run the local MCP server over stdio |

Launch options: `--quote ETH`, `--fee 100|200|300`, `--buy <eth>`, `--split 0xA:5000,0xB:5000`, `--agent-wallet --agent-key 0x… --daily-cap 0.05 --agent-share 5000`.

## AI Agent wallet

For coins launched in AI Agent mode. Load the **agent key** (the address set as the wallet's agent) in `ONONE_PRIVATE_KEY`.

| Command | What it does |
| --- | --- |
| `wallet status --token 0x…` | Balance, fees waiting, today's limit, agent key, owner, pending changes |
| `wallet collect --token 0x…` | Move waiting fees into the agent wallet (anyone can) |
| `wallet buyback --token 0x… --amount <n> [--slippage 5] [--collect]` | Buy the coin with `<n>` of its quote asset and burn it. `--collect` collects fees first if needed |
| `wallet pay --token 0x… --to 0x… --amount <n>` | Pay a payee the owner approved |
| `wallet freeze --token 0x…` | Emergency stop. Only the owner can unfreeze |

Use `--wallet 0x…` instead of `--token` to name the agent wallet directly, `--dry-run` to simulate, `--yes` to skip the prompt. Before signing, the CLI confirms with the OnOne AgentWallet factory that the wallet is genuine, and checks the agent key, the frozen flag, today's limit and the payee list. Buybacks are simulated first and sent with a minimum burn (default 5% slippage).

## Local MCP

```json
{ "mcpServers": { "onone": { "command": "npx", "args": ["-y", "@onone/agent", "mcp"], "env": { "ONONE_API_KEY": "b1a_..." } } } }
```

Read tools and `onone_prepare_launch` always work. `onone_launch` signs and sends only if you set `ONONE_MCP_ALLOW_SEND=1` and a wallet key. Launch buys above `ONONE_MCP_MAX_BUY_ETH` (default `0`) are refused, so a model cannot spend your ETH on its own.

The `onone_wallet_*` tools (`status`, `collect`, `buyback`, `pay`, `freeze`) use the same key and the same switch. Buybacks and payments are refused unless you also set `ONONE_MCP_MAX_WALLET_SPEND` (max per action, in the quote asset), and payments can only go to payees the owner approved on-chain.

Prefer no local key? Use the hosted server at `https://onone.fun/api/mcp` with `Authorization: Bearer <key>`: it returns unsigned transactions for your own wallet to sign.

## Environment

| Variable | Use |
| --- | --- |
| `ONONE_PRIVATE_KEY` | Agent wallet key (local only) |
| `ONONE_API_KEY` | API key (overrides the saved one) |
| `ONONE_RPC_URL` | Base RPC (default `https://mainnet.base.org`) |
| `ONONE_KEY_FILE` | Path to a key file for the MCP server (instead of `ONONE_PRIVATE_KEY`) |
| `ONONE_MCP_ALLOW_SEND` | `1` lets the local MCP server sign launches and agent-wallet actions |
| `ONONE_MCP_MAX_WALLET_SPEND` | Max buyback or payment per MCP action, in the quote asset (default `0` = off) |
| `ONONE_MCP_MAX_BUY_ETH` | Max launch buy the MCP server may send (default `0`) |
| `ONONE_MCP_AGENT_KEY` | If set, MCP launches use AI Agent mode with this agent key (fee routing never comes from the model) |
| `ONONE_MCP_AGENT_DAILY_CAP` / `ONONE_MCP_AGENT_SHARE_BPS` | Agent wallet daily limit and its share of creator fees for MCP launches |

## Moving from @base1/agent

`@base1/agent` is now `@onone/agent`. Nothing breaks if you switch:

- Old `BASE1_*` variables still work. `ONONE_*` wins if both are set.
- A saved login in `~/.config/base1/agent.json` is still read. The next login saves to `~/.config/onone/`.
- The `base1-agent` command still works, and old `base1_*` MCP tool names still run.

Docs: https://onone.fun/docs/agents
