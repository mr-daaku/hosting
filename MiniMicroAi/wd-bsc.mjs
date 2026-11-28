// bsc-chain-withdraw.mjs - scan -> report -> auto withdraw: USDT + USDC + BNB (BSC mainnet)
// FIXED: correct RPC URLs, batch sizes matching real endpoint limits, higher concurrency
// BSC: USDT & USDC 18 decimals, legacy gasPrice (EIP-1559 nahi)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import Bip39 from 'bip39';
import walletPkg from 'ethereumjs-wallet';

const { hdkey } = walletPkg;

const WITHDRAW_SECRET = process.env.WALLET_SECRET;
if (!WITHDRAW_SECRET) {
  console.error('❌ .env me WALLET_SECRET nahi hai');
  process.exit(1);
}
if (!Bip39.validateMnemonic(WITHDRAW_SECRET.trim())) {
  console.error('❌ WALLET_SECRET valid mnemonic nahi hai (words/spelling check karo)');
  process.exit(1);
}

// ============ Config ============
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bsc-balances.json');
const USDT = '0x55d398326f99059fF775485246999027B3197955'; // BSC USDT = 18 decimals
const USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'; // BSC USDC = 18 decimals
const TOKEN_DEC = 18;
const PAY_INDEX = Number(process.env.PAY_INDEX ?? 0);
const RECEIVE_INDEX = Number(process.env.RECEIVE_INDEX ?? 0);
if (!Number.isInteger(PAY_INDEX) || PAY_INDEX < 0 || !Number.isInteger(RECEIVE_INDEX) || RECEIVE_INDEX < 0) {
  console.error('❌ PAY_INDEX / RECEIVE_INDEX sahi number hona chahiye');
  process.exit(1);
}

const MIN_USDT = Number(process.env.MIN_USDT) || 0.01;
const MIN_TOKEN_RAW = ethers.parseUnits(String(MIN_USDT), TOKEN_DEC);
const MIN_BNB = ethers.parseEther(process.env.MIN_BNB || '0.00005');
const MAX_GAS_GWEI = Number(process.env.MAX_GAS_GWEI) || 5;
const GAS_PRICE_MULT = Number(process.env.GAS_PRICE_MULT) || 110;
const GAS_TOKEN = 90000n;
const GAS_BNB = 21000n;
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const iface = new ethers.Interface(ERC20_ABI);

// ⚡ SPEED CONFIG — BSC endpoints usually limit to 100 calls/batch.
// 33 wallets * 3 calls = 99 → fits in ONE request per chunk (no split, no retries)
const BATCH = 33;
const CONC = 18; // ~2.4x ETH version's 6, because we do 2.4x more HTTP round trips
const BALANCE_OF = '0x70a08231';

// Best result ke liye .env me BSC_RPC_URL daalo (NodeReal/QuickNode paid = 1000+ wallet/s)
const CUSTOM_RPC = process.env.BSC_RPC_URL;

// ✅ FIXED: correct URLs + realistic batch limits per endpoint
const READ_RPCS = [
  ...(CUSTOM_RPC ? [{ url: CUSTOM_RPC, maxCalls: Number(process.env.RPC_MAX_CALLS) || 240 }] : []),
  // NodeReal public free — most stable for BSC batching, well-known public endpoint
  { url: 'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3', maxCalls: 1000 },
  // 1RPC — good for batches
  { url: 'https://1rpc.io/bnb', maxCalls: 1000 },
  // drpc — multiple backends behind, good throughput
  { url: 'https://bsc.drpc.org', maxCalls: 1000 },
  // PublicNode — FIXED URL (was bsc.publicnode.com ❌, now bsc-rpc.publicnode.com ✅)
  { url: 'https://bsc-rpc.publicnode.com', maxCalls: 1000 },
  // BlastAPI
  { url: 'https://bsc-mainnet.public.blastapi.io', maxCalls: 1000 },
  // Fallbacks — strict batch limit, only use if primaries all cool down
  { url: 'https://rpc.ankr.com/bsc', maxCalls: 50, only: 'fallback' },
  { url: 'https://bsc-dataseed.bnbchain.org', maxCalls: 20, only: 'fallback' },
  { url: 'https://bsc-dataseed1.defibit.io', maxCalls: 20, only: 'fallback' },
  { url: 'https://bsc-dataseed1.ninicoin.io', maxCalls: 20, only: 'fallback' },
];
const TX_RPCS = [
  ...(CUSTOM_RPC ? [CUSTOM_RPC] : []),
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://binance.llamarpc.com',
];
const TX_PROVIDERS = TX_RPCS.map((u) => new ethers.JsonRpcProvider(u, 56, { staticNetwork: ethers.Network.from(56) }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toBig = (x) => {
  try {
    return BigInt(x && x !== '0x' ? x : '0x0');
  } catch {
    return 0n;
  }
};

// ============ Seed derive ============
function makeDeriver(mnemonic) {
  const seed = Bip39.mnemonicToSeedSync(mnemonic.trim());
  const account = hdkey.fromMasterSeed(seed).derivePath("m/44'/60'/0'/0");
  return {
    address: (index) => ethers.getAddress(account.deriveChild(index).getWallet().getAddressString()),
    wallet: (index) => {
      const w = account.deriveChild(index).getWallet();
      return new ethers.Wallet('0x' + w.getPrivateKey().toString('hex'));
    },
  };
}

const derive = makeDeriver(WITHDRAW_SECRET);
const WITHDRAW_TO = derive.address(RECEIVE_INDEX);
const payWallet = derive.wallet(PAY_INDEX);

// ============ Batch JSON-RPC ============
let epCursor = 0;
const epCool = new Map();
function isRateErr(msg) {
  return /429|compute units|rate.?limit|too many|exceeded/i.test(msg);
}
async function rpcBatch(calls) {
  const eps = READ_RPCS;
  const pref = eps.filter((e) => e.only !== 'fallback');
  const fall = eps.filter((e) => e.only === 'fallback');
  const start = epCursor++;
  const seq = [];
  for (let r = 0; r < 2; r++) for (let i = 0; i < pref.length; i++) seq.push(pref[(start + i) % pref.length]);
  for (const e of fall) seq.push(e);
  const now0 = Date.now();
  if (seq.every((e) => (epCool.get(e.url) || 0) > now0)) epCool.clear();
  let lastErr;
  let tried = 0;
  for (let attempt = 0; attempt < seq.length; attempt++) {
    const ep = seq[attempt];
    if ((epCool.get(ep.url) || 0) > Date.now()) continue;
    if (tried > 0) await sleep(200); // ⚡ was 600 → 200 (faster retry after bad endpoint)
    tried++;
    const tA = Date.now();
    try {
      const out = [];
      for (let i = 0; i < calls.length; i += ep.maxCalls) {
        const part = calls.slice(i, i + ep.maxCalls);
        const payload = part.map((c, j) => ({ jsonrpc: '2.0', id: j, method: c.method, params: c.params }));
        const r = await fetch(ep.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000), // ⚡ was 15s → 10s
        });
        if (!r.ok) throw new Error('http ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j)) throw new Error('batch nahi chala: ' + JSON.stringify(j).slice(0, 120));
        const byId = new Map();
        for (const item of j) byId.set(item.id, item);
        out.push(
          ...part.map((_, k) => {
            const item = byId.get(k);
            if (!item || item.error) throw new Error(item?.error?.message || 'rpc result missing id ' + k);
            return item.result;
          })
        );
      }
      if (process.env.RPC_DEBUG) console.log(`[dbg] ${new URL(ep.url).host} ${calls.length}c a${attempt} ${Date.now() - tA}ms ok`);
      epCool.delete(ep.url);
      return out;
    } catch (e) {
      if (process.env.RPC_DEBUG) console.log(`[dbg] ${new URL(ep.url).host} ${calls.length}c a${attempt} ${Date.now() - tA}ms FAIL: ${e.message.slice(0, 60)}`);
      if (isRateErr(e.message)) epCool.set(ep.url, Date.now() + 30000);
      else if (/timeout|aborted|fetch failed/i.test(e.message)) epCool.set(ep.url, Date.now() + 15000);
      lastErr = e;
    }
  }
  throw lastErr || new Error('sabhi endpoint cooldown me hain');
}

async function readBalances(address) {
  const data = BALANCE_OF + address.slice(2).padStart(64, '0');
  const res = await rpcBatch([
    { method: 'eth_getBalance', params: [address, 'latest'] },
    { method: 'eth_call', params: [{ to: USDT, data }, 'latest'] },
    { method: 'eth_call', params: [{ to: USDC, data }, 'latest'] },
  ]);
  return { bnb: toBig(res[0]), usdt: toBig(res[1]), usdc: toBig(res[2]) };
}

async function readBnb(address) {
  const res = await rpcBatch([{ method: 'eth_getBalance', params: [address, 'latest'] }]);
  return toBig(res[0]);
}

// ============ Gas price (legacy) ============
async function getGasPrice() {
  let lastErr;
  const MIN_GP = ethers.parseUnits('1', 'gwei');
  for (const p of TX_PROVIDERS) {
    try {
      const fd = await p.getFeeData();
      if (fd.gasPrice == null) throw new Error('gasPrice nahi mili');
      const bumped = (fd.gasPrice * BigInt(Math.round(GAS_PRICE_MULT))) / 100n;
      return bumped > MIN_GP ? bumped : MIN_GP;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('gas price nahi mili');
}
const gweiStr = (v) => Number(ethers.formatUnits(v, 'gwei')).toFixed(2);

// ============ Tx send (legacy type 0) ============
async function sendAndWait(wallet, txRequest) {
  let hash = null;
  let lastErr;
  for (const p of TX_PROVIDERS) {
    try {
      const tx = await wallet.connect(p).sendTransaction(txRequest);
      hash = tx.hash;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!hash) throw lastErr;
  for (const p of TX_PROVIDERS) {
    try {
      const r = await p.waitForTransaction(hash, 1, 120000);
      if (r) return r;
    } catch {}
  }
  throw new Error('receipt nahi mila: https://bscscan.com/tx/' + hash);
}

// ============ Scan ============
async function scanBalances(entries) {
  const t0 = Date.now();
  const chunks = [];
  for (let i = 0; i < entries.length; i += BATCH) chunks.push(entries.slice(i, i + BATCH));

  const results = new Array(entries.length);
  let next = 0;
  let done = 0;
  let lastPrinted = 0;
  let lastPrintT = Date.now();
  const failed = [];

  async function fetchChunk(chunk, offset) {
    const calls = [];
    for (const w of chunk) {
      const data = BALANCE_OF + w.address.slice(2).padStart(64, '0');
      calls.push({ method: 'eth_getBalance', params: [w.address, 'latest'] });
      calls.push({ method: 'eth_call', params: [{ to: USDT, data }, 'latest'] });
      calls.push({ method: 'eth_call', params: [{ to: USDC, data }, 'latest'] });
    }
    const res = await rpcBatch(calls);
    chunk.forEach((w, i) => {
      const bnb = parseFloat(ethers.formatEther(toBig(res[i * 3])));
      const usdt = parseFloat(ethers.formatUnits(toBig(res[i * 3 + 1]), TOKEN_DEC));
      const usdc = parseFloat(ethers.formatUnits(toBig(res[i * 3 + 2]), TOKEN_DEC));
      results[offset + i] = { index: w.index, address: w.address, bnb, usdt, usdc };
    });
  }

  async function processChunk(chunk, offset) {
    await fetchChunk(chunk, offset);
    done += chunk.length;
    const now = Date.now();
    if (done - lastPrinted >= 250 || now - lastPrintT >= 5000 || done >= entries.length) {
      lastPrinted = done;
      lastPrintT = now;
      const secs = (Date.now() - t0) / 1000;
      console.log(`⏳ fetch ${done}/${entries.length} | ${Math.round(done / Math.max(secs, 0.001))} wallet/sec`);
    }
  }

  async function processChunkSafe(chunk, offset) {
    try {
      await processChunk(chunk, offset);
    } catch (e) {
      if (process.env.RPC_DEBUG) console.log(`[dbg] chunk(${chunk.length}@${offset}) fail1: ${e.message.slice(0, 60)} -> 2s sleep`);
      await sleep(2000);
      try {
        await processChunk(chunk, offset);
      } catch (e2) {
        if (chunk.length === 1) {
          failed.push({ chunk, offset });
          console.log(`❌ index ${chunk[0].index} fail: ${e2.message.slice(0, 70)}`);
          return;
        }
        const mid = Math.ceil(chunk.length / 2);
        await processChunkSafe(chunk.slice(0, mid), offset);
        await processChunkSafe(chunk.slice(mid), offset + mid);
      }
    }
  }

  let workerNo = 0;
  async function worker() {
    const myNo = workerNo++;
    await sleep(myNo * 150); // ⚡ was 300 → 150
    while (true) {
      const i = next++;
      if (i >= chunks.length) break;
      await processChunkSafe(chunks[i], i * BATCH);
      await sleep(50); // ⚡ was 250 → 50 (removed artificial throttle)
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  if (failed.length) {
    const retryWallets = failed.flatMap((f) => f.chunk);
    console.log(`🔁 ${retryWallets.length} wallet retry (5s baad)...`);
    await sleep(5000);
    const stillFailed = [];
    for (const w of retryWallets) {
      try {
        await fetchChunk([w], entries.findIndex((e) => e.index === w.index));
      } catch (e) {
        stillFailed.push(w.index);
        console.log(`❌ index ${w.index} fail: ${e.message.slice(0, 70)}`);
      }
    }
    if (stillFailed.length) console.log(`⚠️ ${stillFailed.length} wallet scan nahi paye (report me 0): ${stillFailed.slice(0, 10).join(', ')}${stillFailed.length > 10 ? ' ...' : ''}`);
  }

  entries.forEach((e, i) => {
    if (!results[i]) results[i] = { index: e.index, address: e.address, bnb: 0, usdt: 0, usdc: 0 };
  });

  console.log(`✅ scan done: ${results.length} wallet in ${((Date.now() - t0) / 1000).toFixed(1)}s | ${Math.round(results.length / Math.max((Date.now() - t0) / 1000, 0.001))} wallet/sec avg`);
  return results;
}

// ============ Report ============
function writeReport(wallets, start, end) {
  const funded = wallets.filter((w) => (w.bnb || 0) > 0 || (w.usdt || 0) > 0 || (w.usdc || 0) > 0);
  const report = {
    scannedAt: new Date().toISOString(),
    chain: 'BSC',
    source: 'WALLET_SECRET',
    range: { start, end },
    payIndex: PAY_INDEX,
    receiveIndex: RECEIVE_INDEX,
    receiveAddress: WITHDRAW_TO,
    scanned: wallets.length,
    fundedCount: funded.length,
    totalBnb: Number(funded.reduce((s, w) => s + (w.bnb || 0), 0).toFixed(8)),
    totalUsdt: Number(funded.reduce((s, w) => s + (w.usdt || 0), 0).toFixed(6)),
    totalUsdc: Number(funded.reduce((s, w) => s + (w.usdc || 0), 0).toFixed(6)),
    wallets: funded,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  return funded;
}

// ============ Ek wallet ka poora flow ============
let aborted = false;
async function processOne(entry, count) {
  console.log(`\n[#${count}] index ${entry.index} | ${entry.address}`);

  let { bnb, usdt, usdc } = await readBalances(entry.address);
  console.log(`💼 ${ethers.formatUnits(usdt, TOKEN_DEC)} USDT | ${ethers.formatUnits(usdc, TOKEN_DEC)} USDC | ${ethers.formatEther(bnb)} BNB`);

  const gasPrice = await getGasPrice();
  if (Number(ethers.formatUnits(gasPrice, 'gwei')) > MAX_GAS_GWEI) {
    throw new Error(`GAS bahut high: ${gweiStr(gasPrice)} gwei > limit ${MAX_GAS_GWEI} gwei`);
  }
  const sweepGas = GAS_BNB * gasPrice;

  const wantUsdt = usdt >= MIN_TOKEN_RAW;
  const wantUsdc = usdc >= MIN_TOKEN_RAW;
  const wantBnb = bnb > sweepGas + MIN_BNB;
  if (!wantUsdt && !wantUsdc && !wantBnb) {
    console.log(`⏭ kuch bhi withdraw-layak nahi hai - skip`);
    return { index: entry.index, status: 'skipped', reason: 'sab balance bahut kam', assets: {} };
  }

  const wallet = derive.wallet(entry.index);
  const assets = {};
  const tokenCount = (wantUsdt ? 1 : 0) + (wantUsdc ? 1 : 0);
  const needGas = GAS_TOKEN * gasPrice * BigInt(tokenCount);

  if (tokenCount && bnb < needGas) {
    const topUp = needGas - bnb;
    console.log(`⛽ gas kam hai (${gweiStr(gasPrice)} gwei) -> PAY index ${PAY_INDEX} se ${ethers.formatEther(topUp)} BNB top-up...`);
    const pay = await readBnb(payWallet.address);
    if (pay < topUp + sweepGas * 2n) {
      throw new Error(`PAY wallet me BNB kam hai: ${ethers.formatEther(pay)} BNB`);
    }
    const dReceipt = await sendAndWait(payWallet, { to: entry.address, value: topUp, gasLimit: GAS_BNB, gasPrice });
    if (dReceipt.status !== 1) throw new Error('gas deposit revert ho gaya: ' + dReceipt.hash);
    console.log(`✅ gas deposit done | ${dReceipt.hash}`);
    bnb += topUp;
  } else if (tokenCount) {
    console.log(`⛽ token gas pehle se hai (${ethers.formatEther(bnb)} BNB) - deposit skip`);
  }

  let tokenSent = false;

  // ---- USDT ----
  if (wantUsdt) {
    try {
      console.log(`⏳ USDT withdraw (MAX ${ethers.formatUnits(usdt, TOKEN_DEC)}) -> ${WITHDRAW_TO}`);
      const data = iface.encodeFunctionData('transfer', [WITHDRAW_TO, usdt]);
      const receipt = await sendAndWait(wallet, { to: USDT, data, gasLimit: GAS_TOKEN, gasPrice });
      if (receipt.status !== 1) throw new Error('revert: ' + receipt.hash);
      tokenSent = true;
      assets.usdt = { status: 'ok', amount: ethers.formatUnits(usdt, TOKEN_DEC), tx: receipt.hash };
      console.log(`✅ USDT done | ${ethers.formatUnits(usdt, TOKEN_DEC)} | ${receipt.hash}`);
    } catch (e) {
      assets.usdt = { status: 'failed', reason: e.shortMessage || e.message };
      console.log(`❌ USDT fail:`, e.shortMessage || e.message);
    }
  } else {
    assets.usdt = { status: 'skip', reason: '< ' + MIN_USDT + '$' };
  }

  // ---- USDC ----
  if (wantUsdc) {
    try {
      console.log(`⏳ USDC withdraw (MAX ${ethers.formatUnits(usdc, TOKEN_DEC)}) -> ${WITHDRAW_TO}`);
      const data = iface.encodeFunctionData('transfer', [WITHDRAW_TO, usdc]);
      const receipt = await sendAndWait(wallet, { to: USDC, data, gasLimit: GAS_TOKEN, gasPrice });
      if (receipt.status !== 1) throw new Error('revert: ' + receipt.hash);
      tokenSent = true;
      assets.usdc = { status: 'ok', amount: ethers.formatUnits(usdc, TOKEN_DEC), tx: receipt.hash };
      console.log(`✅ USDC done | ${ethers.formatUnits(usdc, TOKEN_DEC)} | ${receipt.hash}`);
    } catch (e) {
      assets.usdc = { status: 'failed', reason: e.shortMessage || e.message };
      console.log(`❌ USDC fail:`, e.shortMessage || e.message);
    }
  } else {
    assets.usdc = { status: 'skip', reason: '< ' + MIN_USDT + '$' };
  }

  // ---- BNB sweep ----
  {
    if (tokenSent) await sleep(4000);
    try {
      const gp2 = await getGasPrice();
      const freshBnb = await readBnb(entry.address);
      const sweepValue = freshBnb - GAS_BNB * gp2;
      if (sweepValue >= MIN_BNB) {
        console.log(`⏳ BNB sweep ${ethers.formatEther(sweepValue)} -> ${WITHDRAW_TO} (gas ${gweiStr(gp2)} gwei)`);
        const receipt = await sendAndWait(wallet, { to: WITHDRAW_TO, value: sweepValue, gasLimit: GAS_BNB, gasPrice: gp2 });
        if (receipt.status !== 1) throw new Error('revert: ' + receipt.hash);
        assets.bnb = { status: 'ok', amount: ethers.formatEther(sweepValue), tx: receipt.hash };
        console.log(`✅ BNB done | ${ethers.formatEther(sweepValue)} | ${receipt.hash}`);
      } else {
        assets.bnb = { status: 'skip', reason: 'sweep-layak nahi (gas ke baad bahut kam)' };
        console.log(`⏭ BNB sweep skip (${ethers.formatEther(freshBnb)} me se gas nikal ke bahut kam)`);
      }
    } catch (e) {
      assets.bnb = { status: 'failed', reason: e.shortMessage || e.message };
      console.log(`❌ BNB fail:`, e.shortMessage || e.message);
    }
  }

  const okCount = Object.values(assets).filter((a) => a.status === 'ok').length;
  const failCount = Object.values(assets).filter((a) => a.status === 'failed').length;
  let status = 'skipped';
  if (okCount && !failCount) status = 'ok';
  else if (okCount && failCount) status = 'partial';
  else if (failCount) status = 'failed';
  return { index: entry.index, status, assets };
}

// ============ Main ============
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  console.log('\n🔎 BSC All-Chain Withdraw (USDT + USDC + BNB)');
  console.log(`🏦 Receive : index ${RECEIVE_INDEX} -> ${WITHDRAW_TO}`);
  console.log(`⛽ PAY     : index ${PAY_INDEX} -> ${payWallet.address}`);
  console.log(`🚫 Ignore  : ${MIN_USDT}$ se kam token | ${ethers.formatEther(MIN_BNB)} BNB se kam sweep`);
  console.log(`🛑 Gas cap : ${MAX_GAS_GWEI} gwei se upar ho to ruk jayega`);
  console.log(`⚡ Speed   : BATCH ${BATCH} wallet/req x ${CONC} parallel workers`);
  console.log(`🌐 RPC     : ${CUSTOM_RPC ? 'custom (BSC_RPC_URL) + public fallback' : 'public RPC (bade range ke liye BSC_RPC_URL daalo)'}`);

  let gp0;
  try {
    gp0 = await getGasPrice();
    console.log(`⛽ Abhi gas: ${gweiStr(gp0)} gwei`);
  } catch (e) {
    console.error('❌ gas price fetch nahi hui:', e.message);
    rl.close();
    return;
  }

  let start, end;
  while (true) {
    const a = (await ask('\nStart index daalo (jaise 0): ')).trim();
    if (!/^\d+$/.test(a)) { console.log('❌ Number daalo'); continue; }
    const b = (await ask('End index daalo (jaise 999): ')).trim();
    if (!/^\d+$/.test(b)) { console.log('❌ Number daalo'); continue; }
    start = Number(a); end = Number(b);
    if (end < start) { console.log('❌ End >= start hona chahiye'); continue; }
    if (end - start + 1 > 100000) { console.log('❌ Range bahut bada hai (max 100000)'); continue; }
    break;
  }

  const t0 = Date.now();
  const entries = [];
  for (let i = start; i <= end; i++) {
    if (i === RECEIVE_INDEX || i === PAY_INDEX) continue;
    entries.push({ index: i, address: derive.address(i) });
  }
  if (!entries.length) {
    console.log('⚪ is range me scan karne layak koi index nahi');
    rl.close();
    return;
  }
  console.log(`✅ derive done: ${entries.length} wallet`);

  const scanned = await scanBalances(entries);
  const funded = writeReport(scanned, start, end);

  const sweepGas0 = GAS_BNB * gp0;
  const sweepMinBnb = parseFloat(ethers.formatEther(sweepGas0 + MIN_BNB));
  const tokenGas0 = GAS_TOKEN * gp0;
  const plan = (w) => {
    const hasUsdt = (w.usdt || 0) >= MIN_USDT;
    const hasUsdc = (w.usdc || 0) >= MIN_USDT;
    const tCount = (hasUsdt ? 1 : 0) + (hasUsdc ? 1 : 0);
    const have = ethers.parseEther((w.bnb || 0).toFixed(18));
    const need = tokenGas0 * BigInt(tCount);
    const topUp = tCount && have < need ? need - have : 0n;
    return { hasUsdt, hasUsdc, tCount, topUp };
  };

  const candidates = funded
    .filter((w) => (w.usdt || 0) >= MIN_USDT || (w.usdc || 0) >= MIN_USDT || (w.bnb || 0) >= sweepMinBnb)
    .sort((a, b) => a.index - b.index);

  console.log(`\n---- Report ----`);
  console.log(`Range  : ${start} - ${end} (scan ${scanned.length} | saved ${funded.length} | withdraw ${candidates.length})`);
  console.log(`Total  : ${Number(funded.reduce((s, w) => s + (w.usdt || 0), 0).toFixed(6))} USDT | ${Number(funded.reduce((s, w) => s + (w.usdc || 0), 0).toFixed(6))} USDC | ${Number(funded.reduce((s, w) => s + (w.bnb || 0), 0).toFixed(8))} BNB`);
  console.log(`💾 File: ${OUT_FILE}`);

  if (!candidates.length) {
    console.log(`\n⚪ withdraw-layak kuch nahi mila`);
    rl.close();
    return;
  }

  console.log(`\n---- Withdraw list ----`);
  let totalTopUp = 0n;
  let topUpWallets = 0;
  candidates.forEach((w, i) => {
    const p = plan(w);
    const parts = [];
    if (p.hasUsdt) parts.push(`${w.usdt} USDT`);
    if (p.hasUsdc) parts.push(`${w.usdc} USDC`);
    if ((w.bnb || 0) >= sweepMinBnb) parts.push(`${w.bnb} BNB`);
    if (p.topUp > 0n) {
      totalTopUp += p.topUp + sweepGas0;
      topUpWallets++;
    }
    console.log(`  #${i + 1} index ${w.index} | ${w.address} | ${parts.join(' + ')} ${p.topUp > 0n ? '(gas dena padega)' : ''}`);
  });

  const go = (await ask(`\n${candidates.length} wallet pe withdraw start karu -> index ${RECEIVE_INDEX} (${WITHDRAW_TO})? (y/n): `)).trim().toLowerCase();
  if (go !== 'y') {
    console.log('👌 report save ho gaya, withdraw cancel');
    rl.close();
    return;
  }

  console.log(`\n🏦 PAY: ${payWallet.address}`);

  if (topUpWallets) {
    const required = totalTopUp + sweepGas0 * 2n;
    const pay = await readBnb(payWallet.address);
    console.log(`⛽ ${topUpWallets} wallet ko gas chahiye = ~${ethers.formatEther(required)} BNB total`);
    if (pay < required) {
      console.log(`\n❌ PAY me BNB kam hai: ${ethers.formatEther(pay)} BNB / ${ethers.formatEther(required)} BNB chahiye`);
      console.log(`👉 PAY wallet (index ${PAY_INDEX}) me kam se kam ${ethers.formatEther(required)} BNB bhejo`);
      rl.close();
      return;
    }
    console.log(`✅ PAY me BNB hai - top-up ho sakta hai`);
  } else {
    console.log(`✅ Sab wallets me token gas hai - PAY se kuch nahi jayega`);
  }

  process.on('SIGINT', () => {
    if (aborted) process.exit(1);
    aborted = true;
    console.log('\n\n⏸ Ctrl+C - current wallet ke baad ruk jaunga...');
  });

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    if (aborted) { console.log('\n⏸ aborted - baaki skip'); break; }
    let res;
    let fatal = false;
    try {
      res = await processOne(candidates[i], i + 1);
    } catch (e) {
      console.log('❌ Fail:', e.shortMessage || e.message);
      res = { index: candidates[i].index, status: 'failed', reason: e.message, assets: {} };
      if (e.message.includes('PAY wallet me BNB kam')) { console.log('⛔ PAY BNB khatam - baaki wallets skip'); fatal = true; }
      if (e.message.includes('GAS bahut high')) { console.log('⛔ Gas bahut high hai - baaki wallets skip'); fatal = true; }
    }
    results.push(res);
    if (fatal) break;
  }

  const ok = results.filter((r) => r.status === 'ok');
  const partial = results.filter((r) => r.status === 'partial');
  const failed2 = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const notTried = candidates.length - results.length;

  let totUsdt = 0, totUsdc = 0, totBnb = 0;
  for (const r of results) {
    if (r.assets?.usdt?.status === 'ok') totUsdt += parseFloat(r.assets.usdt.amount);
    if (r.assets?.usdc?.status === 'ok') totUsdc += parseFloat(r.assets.usdc.amount);
    if (r.assets?.bnb?.status === 'ok') totBnb += parseFloat(r.assets.bnb.amount);
  }

  console.log(`\n---- Summary ----`);
  console.log(`Processed : ${results.length}/${candidates.length}${notTried ? ` (${notTried} baaki)` : ''}`);
  console.log(`✅ Full ok : ${ok.length} | 🟨 Partial: ${partial.length} | ❌ Fail: ${failed2.length} | ⏭ Skip: ${skipped.length}`);
  console.log(`💸 Total withdraw -> index ${RECEIVE_INDEX} (${WITHDRAW_TO})`);
  console.log(`   ${totUsdt.toFixed(6)} USDT | ${totUsdc.toFixed(6)} USDC | ${totBnb.toFixed(8)} BNB`);
  if (failed2.length || partial.length) {
    console.log('❌ Problem list:');
    for (const f of [...partial, ...failed2]) {
      const bits = Object.entries(f.assets || {}).filter(([, a]) => a.status === 'failed').map(([k, a]) => `${k}: ${a.reason}`);
      console.log(`   index ${f.index}: ${bits.length ? bits.join(' | ') : f.reason || f.status}`);
    }
  }
  if (ok.length || partial.length) {
    console.log('✅ Done list:');
    for (const r of [...ok, ...partial]) {
      const bits = Object.entries(r.assets || {}).filter(([, a]) => a.status === 'ok').map(([k, a]) => `${a.amount} ${k.toUpperCase()}`);
      if (bits.length) console.log(`   index ${r.index}: ${bits.join(' + ')}`);
    }
  }
  console.log(`⏱ Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  rl.close();
}

main().catch((e) => {
  console.error('❌ Fail:', e.message);
  process.exit(1);
});