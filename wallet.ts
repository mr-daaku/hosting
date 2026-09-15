// wallet.ts
// Usage: npx tsx wallet.ts <startIndex> <endIndex>
// Example: npx tsx wallet.ts 0 10   -> index 0 se 10 tak, sabhi chains ke addresses print karega
//
// .env file me:
// WALLET_24_WORD="your seed phrase here ..."

import "dotenv/config";
import { deriveAllChains } from "./derive.ts";

const MNEMONIC = process.env.WALLET_24_WORD;

if (!MNEMONIC) {
  console.error("❌ .env me WALLET_24_WORD nahi mila. Pehle .env set karo.");
  process.exit(1);
}

const args = process.argv.slice(2);
const start = parseInt(args[0] ?? "0", 10);
const end = parseInt(args[1] ?? "0", 10);

if (isNaN(start) || isNaN(end) || start < 0 || end < start) {
  console.error("❌ Usage: npx tsx wallet.ts <startIndex> <endIndex>");
  console.error("   Example: npx tsx wallet.ts 0 10");
  process.exit(1);
}

console.log(`\n🔑 Deriving addresses from index ${start} to ${end}\n`);
console.log("=".repeat(95));

for (let i = start; i <= end; i++) {
  const d = deriveAllChains(MNEMONIC, i);
  console.log(`Index ${d.index}`);
  console.log(`  BTC  (${d.btc.path}) : ${d.btc.address}`);
  console.log(`  ETH  (${d.eth.path}) : ${d.eth.address}`);
  console.log(`  BASE (${d.base.path}) : ${d.base.address}  (ETH jaisa hi, EVM chain hai)`);
  console.log(`  TRX  (${d.trx.path}) : ${d.trx.address}`);
  console.log(`  SOL  (${d.sol.path}) : ${d.sol.address}`);
  // Private keys chahiye to yahan d.btc.privateKey, d.eth.privateKey, etc. use karo
  console.log("-".repeat(95));
}