// transactions.js

const readline = require("readline");

// NodeReal API endpoint
const NODEREAL_API = "https://bsc-mainnet.nodereal.io/v1/a64423827429445db203a57251663414";

// BSC par USDT aur USDC ke contract addresses (lowercase)
const USDT_CONTRACT = "0x55d398326f99059ff775485246999027b3197955";
const USDC_CONTRACT = "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d";

// ✅ BigInt string ko plain decimal string me convert karna (scientific notation se bachne ke liye)
function formatUnits(rawValueStr, decimals) {
  let s = rawValueStr.toString();
  if (decimals === 0) return s;

  // Agar value decimals se chhoti hai, to aage zeros lagao
  if (s.length <= decimals) {
    s = "0".repeat(decimals - s.length + 1) + s;
  }

  const intPart = s.slice(0, s.length - decimals) || "0";
  let fracPart = s.slice(s.length - decimals);

  // Trailing zeros hatao
  fracPart = fracPart.replace(/0+$/, "");

  return fracPart ? intPart + "." + fracPart : intPart;
}

// NodeReal se raw transfers laane ka function
async function fetchTransfers(address, addressType = null, maxCount = 100) {
  const body = {
    jsonrpc: "2.0",
    method: "nr_getTransactionByAddress",
    params: [
      {
        category: ["external", "20"],
        addressType: addressType,
        address: address,
        order: "desc",
        maxCount: "0x" + maxCount.toString(16),
      },
    ],
    id: 1,
  };

  const response = await fetch(NODEREAL_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error("NodeReal API error: " + data.error.message);
  }

  return (data.result && data.result.transfers) || [];
}

// Raw transfer ko human-readable object me convert karna
function parseTransfer(t) {
  const category = t.category || "external";
  const contractAddr = (t.contractAddress || "").toLowerCase();
  const assetFromApi = t.asset || "";

  let asset = "UNKNOWN";
  let decimals = 18;

  if (category === "external") {
    asset = "BNB";
    decimals = 18;
  } else if (contractAddr === USDT_CONTRACT) {
    asset = "USDT";
    decimals = 18; // USDT on BSC = 18 decimals
  } else if (contractAddr === USDC_CONTRACT) {
    asset = "USDC";
    decimals = 18; // USDC on BSC = 18 decimals
  } else {
    asset = assetFromApi || "TOKEN";
    // ✅ decimal field hex string hoti hai ("0x12" = 18), ya plain string ("18")
    if (t.decimal) {
      const d = String(t.decimal);
      decimals = d.startsWith("0x") ? parseInt(d, 16) : parseInt(d, 10);
    } else {
      decimals = 18;
    }
  }

  const rawHex = t.value || "0x0";
  const rawValue = BigInt(rawHex).toString();
  const humanValue = formatUnits(rawValue, decimals);

  return {
    hash: t.hash || "",
    from: t.from || "",
    to: t.to || "",
    asset: asset,
    value: humanValue,
    rawValue: rawValue,
    category: category,
    blockNum: t.blockNum || "",
    blockTimestamp: t.blockTimeStamp || t.blockTimestamp || 0,
    status: t.receiptsStatus !== undefined ? t.receiptsStatus : 1,
    contractAddress: t.contractAddress || undefined,
  };
}

// Main function: address do, transactions lo
async function getTransactions(address) {
  const raw = await fetchTransfers(address, null, 100);
  return raw.map(parseTransfer);
}

// Address validate karna
function isValidAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

// ==== INTERACTIVE RUNNER ====
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askAddress = () => {
    return new Promise((resolve) => {
      rl.question("\n🔍 Enter BSC wallet address: ", (answer) => {
        resolve(answer.trim());
      });
    });
  };

  try {
    let address = await askAddress();

    if (!isValidAddress(address)) {
      console.log("❌ Invalid address! Format hona chahiye: 0x + 40 hex characters");
      rl.close();
      return;
    }

    console.log("\n⏳ Fetching transactions...\n");

    const txs = await getTransactions(address);

    console.log("=".repeat(80));
    console.log("📊 Total " + txs.length + " transactions found");
    console.log("=".repeat(80));

    if (txs.length === 0) {
      console.log("\nKoi transaction nahi mili is address ke liye.");
      rl.close();
      return;
    }

    txs.forEach((tx, i) => {
      console.log("\n" + (i + 1) + ". [" + tx.asset + "] " + tx.value + " " + tx.asset);
      console.log("   From:   " + tx.from);
      console.log("   To:     " + tx.to);
      console.log("   Hash:   " + tx.hash);
      console.log("   Block:  " + tx.blockNum);
      console.log("   Status: " + (tx.status === 1 ? "✅ Success" : "❌ Failed"));
    });

    console.log("\n" + "=".repeat(80));

    const usdt = txs.filter((t) => t.asset === "USDT");
    const usdc = txs.filter((t) => t.asset === "USDC");
    const bnb = txs.filter((t) => t.asset === "BNB");

    console.log("\n📈 Summary:");
    console.log("  USDT transactions: " + usdt.length);
    console.log("  USDC transactions: " + usdc.length);
    console.log("  BNB  transactions: " + bnb.length);
    console.log("=".repeat(80) + "\n");

    rl.close();
  } catch (e) {
    console.error("❌ Error:", e.message);
    rl.close();
  }
}

main();