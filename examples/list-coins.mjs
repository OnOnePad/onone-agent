// Newest OnOne coins on Base and the pair tokens you can launch against. No API key needed.
const base = "https://onone.fun";
const coins = await fetch(`${base}/api/v1/coins?chainId=8453&page=1&pageSize=10`).then((r) => r.json());
for (const c of coins.coins ?? []) console.log(`$${c.symbol.padEnd(10)} ${c.name.padEnd(24)} ${c.url ?? ""}`);
const quotes = await fetch(`${base}/api/v1/quotes?chainId=8453`).then((r) => r.json());
console.log("\nPair tokens:", (quotes.quotes ?? []).map((q) => q.displaySymbol ?? q.symbol).join(", "));
