// price-menu.js (loop version)
const readline = require("readline");

async function getPrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code) throw new Error(data.msg || "Symbol not found");
  return parseFloat(data.price);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) =>
    new Promise((resolve) => rl.question(q, (ans) => resolve(ans.trim())));

  const map = {
    "1": { name: "BNB", symbol: "BNBUSDT" },
    "2": { name: "ETH", symbol: "ETHUSDT" },
    "3": { name: "GRAM", symbol: "GRAMUSDT" },
  };

  while (true) {
    console.log("\n========== CRYPTO PRICE MENU ==========");
    console.log("1. BNB  -> USDT");
    console.log("2. ETH  -> USDT");
    console.log("3. GRAM -> USDT");
    console.log("0. Exit");
    console.log("=======================================\n");

    const choice = await ask("Apna option chuno (0-3): ");

    if (choice === "0") {
      console.log("\n👋 Bye!\n");
      break;
    }

    const selected = map[choice];
    if (!selected) {
      console.log("\n❌ Galat option! 0-3 ke beech chuno.\n");
      continue;
    }

    try {
      console.log(`\n⏳ ${selected.name} ka price fetch kar rahe hain...\n`);
      const price = await getPrice(selected.symbol);
      const inverse = 1 / price;

      console.log("=".repeat(50));
      console.log(`📊 ${selected.name} / USDT Price`);
      console.log("=".repeat(50));
      console.log(`💰 1 ${selected.name}  =  ${price.toFixed(4)} USDT`);
      console.log(`💵 1 USDT  =  ${inverse.toFixed(8)} ${selected.name}`);
      console.log("=".repeat(50));
      console.log(`🕒 ${new Date().toLocaleString()}`);
      console.log("=".repeat(50));
    } catch (e) {
      console.log("❌ Error:", e.message);
    }
  }

  rl.close();
}

main();