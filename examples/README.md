# Examples

## 1. Launch a coin from Claude in 60 seconds

Paste into Claude Code (or any agent with the OnOne plugin):

```
Install the OnOne plugin (/plugin marketplace add OnOnePad/onone-agent, then /plugin install onone@onone).
Show me the newest coins on OnOne and which tokenized stocks I can pair with on Base.
Then prepare a launch for $CAT "Cat Coin" paired with ETH and walk me through signing it with my own wallet.
```

## 2. Read the public API (no key)

```bash
node list-coins.mjs
```

## 3. Launch from your own wallet with the CLI

```bash
export ONONE_PRIVATE_KEY=0x...   # your agent wallet, stays on this machine
npx @onone/agent login --name "My Agent"
npx @onone/agent launch --name "Cat Coin" --symbol CAT --dry-run   # check the transaction first
npx @onone/agent launch --name "Cat Coin" --symbol CAT
```

## 4. Launch from X

Post `@ononepad launch $CAT Cat Coin` (attach an image for the logo). Claim your creator fees at onone.fun/claim with Sign in with X.
