// ton-scan.js
const readline = require("readline");

// TonCenter API endpoint
const TON_API = "https://toncenter.com/api/v2";

// Nanotons ko TON mein convert karo (9 decimals)
function formatNano(nano) {
  const n = BigInt(nano);
  const intPart = n / 1000000000n;
  const fracPart = n % 1000000000n;
  let fracStr = fracPart.toString().padStart(9, "0").replace(/0+$/, "");
  return fracStr ? `${intPart}.${fracStr}` : intPart.toString();
}

// ✅ Memo nikalne ka improved function
function extractMemo(msg) {
  if (!msg) return "";

  // 1) TonCenter kabhi kabhi `message` field mein plain text comment deta hai
  if (msg.message && typeof msg.message === "string" && msg.message.trim()) {
    return msg.message.trim();
  }

  // 2) msg_data.body se decode karo (base64)
  if (msg.msg_data && msg.msg_data.body) {
    try {
      const buffer = Buffer.from(msg.msg_data.body, "base64");

      // Text comment ka op code 0x00000000 hota hai
      if (buffer.length >= 4) {
        const opCode = buffer.readUInt32BE(0);

        if (opCode === 0) {
          const text = buffer.slice(4).toString("utf8");
          // Sirf printable + Hindi/Devanagari characters rakho
          const clean = text
            .replace(/[^\x20-\x7E\u0900-\u097F]/g, "")
            .trim();
          if (clean) return clean;
        }

        // Encrypted comment ka op code 0x2167da4b hota hai — usse skip karo
        if (opCode === 0x2167da4b) {
          return ""; // encrypted, dikhaya nahi ja sakta
        }
      }
    } catch (e) {
      // ignore
    }
  }

  // 3) Kuch nahi mila to blank
  return "";
}

// TON API se transactions lao
async function getTONTransactions(address, limit = 20) {
  const url = `${TON_API}/getTransactions?address=${address}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!data.ok) {
    throw new Error("TON API error: " + (data.error || "Unknown"));
  }
  return data.result || [];
}

// Transaction ko parse karo
function parseTONTransaction(tx) {
  const transfers = [];
  const inMsg = tx.in_msg;
  const outMsgs = tx.out_msgs || [];

  // ---- INCOMING ----
  if (inMsg) {
    const memo = extractMemo(inMsg);
    if (inMsg.value && inMsg.value !== "0") {
      transfers.push({
        asset: "TON",
        from: inMsg.source || "",
        to: inMsg.destination || "",
        value: formatNano(inMsg.value),
        memo: memo,
        hash: tx.transaction_id?.hash || "",
        timestamp: tx.utime || 0,
        direction: "IN",
      });
    } else if (memo) {
      transfers.push({
        asset: "MEMO_ONLY",
        from: inMsg.source || "",
        to: inMsg.destination || "",
        value: "0",
        memo: memo,
        hash: tx.transaction_id?.hash || "",
        timestamp: tx.utime || 0,
        direction: "IN",
      });
    }
  }

  // ---- OUTGOING ----
  outMsgs.forEach((outMsg) => {
    const memo = extractMemo(outMsg);
    if (outMsg.value && outMsg.value !== "0") {
      transfers.push({
        asset: "TON",
        from: outMsg.source || "",
        to: outMsg.destination || "",
        value: formatNano(outMsg.value),
        memo: memo,
        hash: tx.transaction_id?.hash || "",
        timestamp: tx.utime || 0,
        direction: "OUT",
      });
    } else if (memo) {
      transfers.push({
        asset: "MEMO_ONLY",
        from: outMsg.source || "",
        to: outMsg.destination || "",
        value: "0",
        memo: memo,
        hash: tx.transaction_id?.hash || "",
        timestamp: tx.utime || 0,
        direction: "OUT",
      });
    }
  });

  if (transfers.length === 0) {
    transfers.push({
      asset: "OTHER",
      from: inMsg?.source || "",
      to: inMsg?.destination || "",
      value: "0",
      memo: "",
      hash: tx.transaction_id?.hash || "",
      timestamp: tx.utime || 0,
      direction: "?",
    });
  }

  return transfers;
}

function isValidTONAddress(addr) {
  return /^(EQ|UQ|0:)/i.test(addr) || /^[A-Za-z0-9_-]{48}$/.test(addr);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askAddress = () =>
    new Promise((resolve) =>
      rl.question("\n🔍 TON wallet address daalo: ", (ans) => resolve(ans.trim()))
    );

  try {
    let address = await askAddress();

    if (!isValidTONAddress(address)) {
      console.log("❌ Invalid TON address! Sahi address daalo.");
      rl.close();
      return;
    }

    console.log("\n⏳ Transactions fetch ho rahe hain...\n");
    const txs = await getTONTransactions(address, 20);

    console.log("=".repeat(80));
    console.log(`📊 Total ${txs.length} transactions mile`);
    console.log("=".repeat(80));

    if (txs.length === 0) {
      console.log("\nKoi transaction nahi mila is address ke liye.");
      rl.close();
      return;
    }

    txs.forEach((tx, i) => {
      const transfers = parseTONTransaction(tx);

      console.log(`\n${i + 1}. Transaction: ${(tx.transaction_id?.hash || "").slice(0, 20)}...`);
      console.log(`   Time: ${new Date((tx.utime || 0) * 1000).toLocaleString()}`);

      transfers.forEach((t) => {
        if (t.asset === "TON") {
          console.log(`   [${t.direction}] ${t.value} TON`);
          console.log(`     From: ${t.from}`);
          console.log(`     To:   ${t.to}`);
          console.log(`     Memo: ${t.memo || ""}`);
        } else if (t.asset === "MEMO_ONLY") {
          console.log(`   [${t.direction}] Sirf Memo (value 0)`);
          console.log(`     From: ${t.from}`);
          console.log(`     To:   ${t.to}`);
          console.log(`     Memo: ${t.memo || ""}`);
        } else {
          console.log(`   [${t.direction}] Other / Jetton transfer`);
          console.log(`     From: ${t.from}`);
          console.log(`     To:   ${t.to}`);
          console.log(`     Memo: ${t.memo || ""}`);
        }
      });
    });

    console.log("\n" + "=".repeat(80) + "\n");
    rl.close();
  } catch (e) {
    console.error("❌ Error:", e.message);
    rl.close();
  }
}

main();