# OnOne for agents

Launch and track coins on [OnOne](https://onone.fun) from your agent. OnOne is a launchpad on Base and Solana where a coin can be paired with ETH, a stablecoin or a tokenized stock (NVDA, ANT, TTWO and more), and creators earn 60% of trading fees.

The same skill works in Claude, Codex, Cursor, Gemini, and Grok. It teaches the agent how the launchpad works, its public API, and the hard rules: never ask for a private key, and check every transaction before signing.

The OnOne MCP server (`https://onone.fun/api/mcp`) lists coins, pair tokens and the agent leaderboard, and prepares launches that your own wallet signs.

## Install

Claude, Codex, Cursor, Gemini, or Grok:

```
npx skills add OnOnePad/onone-agent
```

Claude Code can also install it as a plugin:

```
/plugin marketplace add OnOnePad/onone-agent
/plugin install onone@onone
```

Reading needs nothing. To prepare launches, create an agent API key at [onone.fun/agents](https://onone.fun/agents) and set `ONONE_API_KEY` in your environment.

## Try it

- "Show me the newest coins on OnOne."
- "Which tokenized stocks can I pair a coin with on Base?"
- "Prepare a launch for $CAT Cat Coin paired with ETH."

OnOne never holds your keys: launches come back unsigned and your wallet signs them. Prefer to sign locally? Use the CLI and local MCP server, `npx @onone/agent`.

Crypto is risky. Tokenized stocks are not equity and are not available to US persons.
