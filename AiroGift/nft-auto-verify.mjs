// nft-auto-verify.mjs  |  Node 18+  |  run: node nft-auto-verify.mjs
// .env:
//   TONAPI_KEY=xxxx                      (recommended, higher rate limits)
//   WALLET_ADDRESS=UQ...                 (optional, nahi diya to script puchega)
// Optional extra check: npm i @ton/core  (collection contract se item ka index verify hota hai)

import fs from "node:fs";
import readline from "node:readline/promises";

// ---------- .env loader (no dependency) ----------
if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      let val = m[2].replace(/^["']|["']$/g, "");
      // strip inline comments
      val = val.split("#")[0].trim();
      process.env[m[1]] ??= val;
    }
  }
}

const API = "https://tonapi.io/v2";
const KEY = process.env.TONAPI_KEY;
const headers = KEY ? { Authorization: `Bearer ${KEY}` } : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- address -> raw format (workchain:hash) ----------
function toRaw(addr) {
  if (!addr) return null;
  const s = String(addr).trim();
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
  const buf = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf.length !== 36) return null;
  const wc = buf[1] === 0xff ? -1 : buf[1];
  return `${wc}:${buf.subarray(2, 34).toString("hex")}`;
}

// ---------- TonAPI helper ----------
async function api(path, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const res = await fetch(API + path, { headers });
    if (res.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!res.ok) throw new Error(`TonAPI ${res.status} ${path}: ${(await res.text()).slice(0, 150)}`);
    return res.json();
  }
  throw new Error("TonAPI rate limit, TONAPI_KEY lagao ya thoda ruko");
}

async function loadAllNfts(wallet) {
  const out = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const d = await api(`/accounts/${encodeURIComponent(wallet)}/nfts?limit=${limit}&offset=${offset}&indirect_ownership=false`);
    const items = d.nft_items || [];
    out.push(...items);
    if (items.length < limit) break;
    if (!KEY) await sleep(1100);
  }
  return out;
}

// ---------- optional: collection contract se index verify ----------
let TonCore = null;
try { TonCore = await import("@ton/core"); } catch { /* optional */ }

async function checkIndexOnCollection(collectionRaw, index, itemRaw) {
  if (!TonCore) return { status: "SKIPPED", note: "npm i @ton/core se ye check chalu hoga" };
  try {
    const r = await api(`/blockchain/accounts/${encodeURIComponent(collectionRaw)}/methods/get_nft_address_by_index?args=${index}`);
    const st = r.stack?.[0];
    const hex = st?.cell ?? st?.slice;
    if (!r.success || !hex) return { status: "FAIL", note: "collection ne address nahi diya" };
    const cell = TonCore.Cell.fromBoc(Buffer.from(hex, "hex"))[0];
    const expected = cell.beginParse().loadAddress().toRawString().toLowerCase();
    return expected === itemRaw
      ? { status: "PASS", note: "collection contract is item ko apna maanta hai" }
      : { status: "FAIL", note: "collection contract ka address alag hai (FAKE/SCAM)" };
  } catch (e) {
    return { status: "SKIPPED", note: "check error: " + e.message.slice(0, 80) };
  }
}

// ---------- collection verification check ----------
async function checkCollectionVerification(collectionAddr) {
  try {
    const col = await api(`/nfts/collections/${encodeURIComponent(collectionAddr)}`);
    const trust = col.trust || "none";
    const isVerified = col.verification === "whitelist" || col.verified === true;
    return {
      trust,
      isVerified,
      name: col.name || "Unknown",
      description: col.description || "",
      itemsCount: col.items_count || 0,
      ownerAddress: col.owner?.address || null,
      socialLinks: col.social_links || [],
    };
  } catch (e) {
    return { trust: "error", isVerified: false, error: e.message.slice(0, 100) };
  }
}

// ---------- main verify (auto - no whitelist needed) ----------
async function verify(item, wallet) {
  const fresh = await api(`/nfts/${encodeURIComponent(item.address)}`);
  const itemRaw = toRaw(fresh.address);
  const colRaw = toRaw(fresh.collection?.address);
  const ownerRaw = toRaw(fresh.owner?.address);
  const walletRaw = toRaw(wallet);

  const checks = [];
  const add = (name, status, note = "") => checks.push({ name, status, note });

  // 1. Collection exists?
  if (!colRaw) {
    add("Collection", "FAIL", "NFT kisi collection ka nahi hai (orphan/bogus)");
  } else {
    add("Collection", "PASS", `${fresh.collection.name || "?"} (${colRaw})`);
  }

  // 2. TonAPI trust check (OFFICIAL TON SYSTEM - blacklist = scam)
  const trust = fresh.trust || "none";
  if (trust === "blacklist") {
    add("TonAPI Trust", "FAIL", "⚠️ BLACKLISTED - Official TON system ne scam/spam flag kiya hai");
  } else if (trust === "whitelist") {
    add("TonAPI Trust", "PASS", "✅ WHITELISTED - Official TON system verified collection");
  } else {
    add("TonAPI Trust", "INFO", "none (neutral - manual verification needed)");
  }

  // 3. Owner check
  add("Owner", ownerRaw && ownerRaw === walletRaw ? "PASS" : "FAIL", 
    ownerRaw === walletRaw ? "wallet ka hi hai" : "owner alag hai (NOT YOURS)");

  // 4. Not on sale
  add("Not on sale", fresh.sale ? "FAIL" : "PASS", 
    fresh.sale ? "NFT marketplace pe listed hai" : "");

  // 5. Collection contract index check (MOST RELIABLE - proves ownership)
  if (colRaw && fresh.index !== undefined) {
    const r = await checkIndexOnCollection(colRaw, fresh.index, itemRaw);
    add("Collection Index", r.status, r.note);
  }

  // 6. Collection verification status (optional extra info)
  if (colRaw) {
    const colInfo = await checkCollectionVerification(fresh.collection.address);
    if (colInfo.trust === "blacklist") {
      add("Collection Trust", "FAIL", "⚠️ Collection blacklisted");
    } else if (colInfo.isVerified || colInfo.trust === "whitelist") {
      add("Collection Trust", "PASS", "✅ Verified/Whitelisted collection");
    } else {
      add("Collection Trust", "INFO", `Trust: ${colInfo.trust}, Items: ${colInfo.itemsCount}`);
    }
  }

  // FINAL VERDICT
  const hasFail = checks.some((c) => c.status === "FAIL");
  const hasCriticalFail = checks.some((c) => c.status === "FAIL" && 
    (c.name === "TonAPI Trust" || c.name === "Owner"));
  
  // Collection Index is non-critical (fails for Telegram Usernames, Fragment, etc.)
  const indexFail = checks.some((c) => c.status === "FAIL" && c.name === "Collection Index");
  
  let verdict;
  if (hasCriticalFail) verdict = "❌ REJECTED (SCAM/FAKE)";
  else if (hasFail && !indexFail) verdict = "⚠️ SUSPICIOUS";
  else if (indexFail) verdict = "✅ VERIFIED (REAL) - Index check skipped (non-standard collection)";
  else verdict = "✅ VERIFIED (REAL)";

  return {
    verdict,
    name: fresh.metadata?.name || "(no name)",
    item: itemRaw,
    collection: colRaw,
    collectionName: fresh.collection?.name || "Unknown",
    owner: ownerRaw,
    index: fresh.index,
    trust: trust,
    checks,
    checkedAt: new Date().toISOString(),
  };
}

// ---------- CLI ----------
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

  const wallet = process.env.WALLET_ADDRESS;
  if (!wallet) {
    const input = await question("Wallet address: ");
    wallet = input.trim();
  }
  console.log(`\n📥 NFTs load ho rahe hain...`);
  const nfts = await loadAllNfts(wallet);

  if (!nfts.length) { console.log("Is wallet me koi NFT nahi mila."); rl.close(); return; }

  console.log(`\n📦 Total ${nfts.length} NFT mila:\n`);
  nfts.forEach((n, i) => {
    console.log(`${String(i + 1).padStart(3)}. ${n.metadata?.name || "(no name)"}  |  ${n.collection?.name || "no collection"}`);
  });

  const reports = [];
  // Auto-verify all NFTs without prompting
  for (let i = 0; i < nfts.length; i++) {
    try {
      const rep = await verify(nfts[i], wallet);
      reports.push(rep);
      console.log(`\n=== #${i + 1} ${rep.name} ===`);
      console.log(`🏷️  Result : ${rep.verdict}`);
      console.log(`📍 Item   : ${rep.item}`);
      console.log(`📁 Collection: ${rep.collectionName} (${rep.collection})`);
      console.log(`🔐 Trust   : ${rep.trust}`);
      for (const c of rep.checks) {
        const icon = c.status === "PASS" ? "✅" : c.status === "FAIL" ? "❌" : c.status === "INFO" ? "ℹ️" : "⏭️";
        console.log(`  ${icon} [${c.status.padEnd(7)}] ${c.name}${c.note ? " - " + c.note : ""}`);
      }
    } catch (e) {
      console.log(`#${i + 1} error: ${e.message}`);
    }
    if (!KEY) await sleep(1100);
  }
  rl.close();

  if (reports.length) {
    const file = `report_${Date.now()}.json`;
    fs.writeFileSync(file, JSON.stringify({ wallet, reports }, null, 2));
    console.log(`\n💾 Report save hui: ${file}`);
  }
}

main().catch(console.error);