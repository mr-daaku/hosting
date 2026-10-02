// bsc-scan-withdraw.mjs - range scan -> report -> auto loop: fee deposit (jarurat par) -> USDT max withdraw
import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import { ethers } from 'ethers';
import Bip39 from 'bip39';
import walletPkg from 'ethereumjs-wallet';

const { hdkey } = walletPkg;

const WITHDRAW_SECRET = process.env.WALLET_SECRET;
const PAY_SECRET = process.env.PAY_WALLET_SECRET;
if (!WITHDRAW_SECRET || !PAY_SECRET) {
  console.error('❌ .env me WALLET_SECRET / PAY_WALLET_SECRET nahi hai');
  process.exit(1);
}

// ============ Config ============
const OUT_FILE = 'C:\\Users\\Gaurav\\OneDrive\\Desktop\\wallet\\wallet-balances.json';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const WITHDRAW_TO = '0x1F20eb36A47F0Db1A6356aE70AD24B8bCffd4167';
const PAY_INDEX = 0;
const FEE_BNB = ethers.parseEther('0.000005'); // gas fee (0.05 gwei * ~65k gas = ~0.0000033 BNB)
const PAY_DEP_GAS = ethers.parseEther('0.0000015'); // PAY ke khud ke deposit gas ka budget
const MIN_USDT = 0.01; // itne $ se kam wale ignore
const MIN_USDT_RAW = ethers.parseUnits(String(MIN_USDT), 18);
const PAY_BUFFER = ethers.parseEther('0.000002'); // PAY ke apne gas ke liye extra
const ERC20_ABI = ['function transfer(address to, uint256 amount) returns (bool)'];
const iface = new ethers.Interface(ERC20_ABI);

const READ_EPS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc.rpc.blxrbdn.com',
  'https://bsc-mainnet.public.blastapi.io',
  'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
  'https://bsc.publicnode.com',
  'https://1rpc.io/bnb',
];
const TX_RPCS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3',
];
const BATCH = 50;
const CONCURRENCY = 6;
const BALANCE_OF = '0x70a08231';

// ============ Batch JSON-RPC (retry + endpoint rotate) ============
async function rpcBatch(calls) {
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  let lastErr;
  for (let attempt = 0; attempt < READ_EPS.length * 2; attempt++) {
    const url = READ_EPS[attempt % READ_EPS.length];
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error('batch nahi chala: ' + JSON.stringify(j).slice(0, 120));
      const byId = new Map();
      for (const item of j) byId.set(item.id, item);
      return calls.map((_, i) => {
        const item = byId.get(i);
        if (!item || item.error) throw new Error(item?.error?.message || 'rpc result missing id ' + i);
        return item.result;
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function readBalances(address) {
  const res = await rpcBatch([
    { method: 'eth_getBalance', params: [address, 'latest'] },
    { method: 'eth_call', params: [{ to: USDT, data: BALANCE_OF + address.slice(2).padStart(64, '0') }, 'latest'] },
  ]);
  return { bnb: BigInt(res[0]), usdt: BigInt(res[1] || '0x0') };
}

// ============ Tx send (multi RPC fallback) ============
async function sendAndWait(wallet, txRequest) {
  const providers = TX_RPCS.map((u) => new ethers.JsonRpcProvider(u));
  let hash = null;
  let lastErr;
  for (const p of providers) {
    try {
      const tx = await wallet.connect(p).sendTransaction(txRequest);
      hash = tx.hash;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (!hash) throw lastErr;
  for (const p of providers) {
    try {
      const r = await p.waitForTransaction(hash, 1, 60000);
      if (r) return r;
    } catch {}
  }
  throw new Error('receipt nahi mila: https://bscscan.com/tx/' + hash);
}

// ============ Seed derive (ek hi baar) ============
async function makeDeriver(mnemonic) {
  const seed = await Bip39.mnemonicToSeed(mnemonic);
  return {
    address: (index) => {
      const node = hdkey.fromMasterSeed(seed).derivePath(`m/44'/60'/0'/0/${index}`);
      return ethers.getAddress(node.getWallet().getAddressString());
    },
    wallet: (index) => {
      const node = hdkey.fromMasterSeed(seed).derivePath(`m/44'/60'/0'/0/${index}`);
      return new ethers.Wallet('0x' + node.getWallet().getPrivateKey().toString('hex'));
    },
  };
}

// ============ Scan (batch balances) ============
async function scanBalances(entries) {
  const t0 = Date.now();
  const chunks = [];
  for (let i = 0; i < entries.length; i += BATCH) chunks.push(entries.slice(i, i + BATCH));

  const results = new Array(entries.length);
  let next = 0;
  let done = 0;
  let lastPrinted = 0;

  async function processChunk(chunk, offset) {
    const calls = [];
    for (const w of chunk) {
      calls.push({ method: 'eth_getBalance', params: [w.address, 'latest'] });
      calls.push({ method: 'eth_call', params: [{ to: USDT, data: BALANCE_OF + w.address.slice(2).padStart(64, '0') }, 'latest'] });
    }
    const res = await rpcBatch(calls);
    chunk.forEach((w, i) => {
      let bnb = null, usdt = null;
      try { bnb = parseFloat(ethers.formatEther(BigInt(res[i * 2]))); } catch {}
      try { usdt = parseFloat(ethers.formatUnits(BigInt(res[i * 2 + 1] || '0x0'), 18)); } catch {}
      results[offset + i] = { index: w.index, address: w.address, bnb, usdt };
    });
    done += chunk.length;
    if (done - lastPrinted >= 250 || done === entries.length) {
      lastPrinted = done;
      const secs = (Date.now() - t0) / 1000;
      console.log(`⏳ fetch ${done}/${entries.length} | ${Math.round(done / Math.max(secs, 0.001))} wallet/sec`);
    }
  }

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= chunks.length) break;
      await processChunk(chunks[i], i * BATCH);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`✅ scan done: ${results.length} wallet in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return results;
}

// ============ Report (sirf funded wallets) ============
function writeReport(wallets, start, end) {
  const funded = wallets.filter((w) => (w.bnb || 0) > 0 || (w.usdt || 0) > 0);
  const report = {
    scannedAt: new Date().toISOString(),
    chain: 'BSC',
    source: 'WALLET_SECRET',
    range: { start, end },
    scanned: wallets.length,
    fundedCount: funded.length,
    totalBnb: Number(funded.reduce((s, w) => s + (w.bnb || 0), 0).toFixed(8)),
    totalUsdt: Number(funded.reduce((s, w) => s + (w.usdt || 0), 0).toFixed(6)),
    wallets: funded,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  return funded;
}

// ============ Ek wallet ka poora flow: fresh check -> fee deposit -> withdraw ============
let aborted = false;
async function processOne(entry, count, derive, payWallet) {
  console.log(`\n[#${count}] index ${entry.index} | ${entry.address}`);

  let bnb, usdt;
  ({ bnb, usdt } = await readBalances(entry.address));
  console.log(`💼 ${ethers.formatUnits(usdt, 18)} USDT | ${ethers.formatEther(bnb)} BNB`);

  if (usdt < MIN_USDT_RAW) {
    console.log(`⏭ ${MIN_USDT}$ se kam hai - skip`);
    return { index: entry.index, status: 'skipped', reason: 'balance < ' + MIN_USDT + '$' };
  }

  const wallet = derive.wallet(entry.index);

  if (bnb < FEE_BNB) {
    console.log(`⛽ fee nahi hai -> PAY index ${PAY_INDEX} se ${ethers.formatEther(FEE_BNB)} BNB deposit...`);
    const pay = await readBalances(payWallet.address);
    if (pay.bnb < FEE_BNB + PAY_BUFFER) {
      throw new Error(`PAY wallet me BNB kam hai: ${ethers.formatEther(pay.bnb)} BNB`);
    }
    const dReceipt = await sendAndWait(payWallet, { to: entry.address, value: FEE_BNB });
    if (dReceipt.status !== 1) throw new Error('fee deposit revert ho gaya: ' + dReceipt.hash);
    console.log(`✅ fee deposit done | ${dReceipt.hash}`);
  } else {
    console.log(`⛽ fee pehle se hai (${ethers.formatEther(bnb)} BNB) - deposit skip`);
  }

  ({ usdt } = await readBalances(entry.address));
  if (usdt < MIN_USDT_RAW) throw new Error('deposit ke baad USDT kam ho gaya - skip');
  console.log(`⏳ USDT withdraw (MAX ${ethers.formatUnits(usdt, 18)}) -> ${WITHDRAW_TO}`);

  const data = iface.encodeFunctionData('transfer', [WITHDRAW_TO, usdt]);
  const receipt = await sendAndWait(wallet, { to: USDT, data });
  if (receipt.status !== 1) throw new Error('USDT transfer revert: ' + receipt.hash);

  console.log(`✅ withdraw done | ${ethers.formatUnits(usdt, 18)} USDT | https://bscscan.com/tx/${receipt.hash}`);
  return { index: entry.index, status: 'ok', amount: ethers.formatUnits(usdt, 18), tx: receipt.hash };
}

// ============ Main ============
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  console.log('\n🔎 BSC Scan + Withdraw (auto loop)');
  console.log(`🏦 Target : USDT MAX withdraw -> ${WITHDRAW_TO}`);
  console.log(`⛽ Fee    : ${ethers.formatEther(FEE_BNB)} BNB (jarurat par PAY index ${PAY_INDEX} se)`);
  console.log(`🚫 Ignore : ${MIN_USDT}$ se kam balance`);

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
  const derive = await makeDeriver(WITHDRAW_SECRET);
  const entries = [];
  for (let i = start; i <= end; i++) entries.push({ index: i, address: derive.address(i) });
  console.log(`✅ derive done: ${entries.length} wallet`);

  const scanned = await scanBalances(entries);
  const funded = writeReport(scanned, start, end);

  const candidates = funded
    .filter((w) => (w.usdt || 0) >= MIN_USDT)
    .sort((a, b) => a.index - b.index);

  console.log(`\n---- Report ----`);
  console.log(`Range  : ${start} - ${end} (scan ${scanned.length} | saved ${funded.length} | withdraw ${candidates.length})`);
  console.log(`Total  : ${Number(funded.reduce((s, w) => s + (w.bnb || 0), 0).toFixed(8))} BNB | ${Number(funded.reduce((s, w) => s + (w.usdt || 0), 0).toFixed(6))} USDT`);
  console.log(`💾 File: ${OUT_FILE}`);

  if (!candidates.length) {
    console.log(`\n⚪ ${MIN_USDT}$ se upar koi USDT balance nahi mila - withdraw kuch nahi hai`);
    rl.close();
    return;
  }

  console.log(`\n---- Withdraw list (USDT >= ${MIN_USDT}$) ----`);
  candidates.forEach((w, i) => {
    const feeOk = (w.bnb || 0) >= parseFloat(ethers.formatEther(FEE_BNB));
    console.log(`  #${i + 1} index ${w.index} | ${w.address} | ${w.usdt} USDT | ${w.bnb ?? '?'} BNB ${feeOk ? '(fee ok)' : '(fee dena padega)'}`);
  });

  const go = (await ask(`\n${candidates.length} wallet pe withdraw start karu? (y/n): `)).trim().toLowerCase();
  if (go !== 'y') {
    console.log('👌 report save ho gaya, withdraw cancel');
    rl.close();
    return;
  }

  const payDerive = await makeDeriver(PAY_SECRET);
  const payWallet = payDerive.wallet(PAY_INDEX);
  console.log(`\n🏦 PAY: ${payWallet.address}`);

  const needFee = candidates.filter((w) => (w.bnb || 0) < parseFloat(ethers.formatEther(FEE_BNB)));
  if (needFee.length) {
    const required = (FEE_BNB + PAY_DEP_GAS) * BigInt(needFee.length);
    const pay = await readBalances(payWallet.address);
    console.log(`⛽ ${needFee.length} wallet ko fee chahiye (har ek ~${ethers.formatEther(FEE_BNB)} BNB) = ${ethers.formatEther(required)} BNB total`);
    if (pay.bnb < required) {
      console.log(`\n❌ PAY me BNB kam hai: ${ethers.formatEther(pay.bnb)} BNB / ${ethers.formatEther(required)} BNB chahiye`);
      console.log(`👉 PAY wallet me kam se kam ${ethers.formatEther(required)} BNB bhejo, fir dobara run karo`);
      rl.close();
      return;
    }
    console.log(`✅ PAY me BNB hai - deposit ho sakta hai`);
  } else {
    console.log(`✅ Sab wallets me fee hai - PAY se kuch nahi jayega`);
  }

  process.on('SIGINT', () => {
    if (aborted) process.exit(1);
    aborted = true;
    console.log('\n\n⏸ Ctrl+C - current wallet ke baad ruk jaunga...');
  });

  const results = [];
  for (let i = 0; i < candidates.length; i++) {
    if (aborted) {
      console.log('\n⏸ aborted - baaki skip');
      break;
    }
    let res;
    let fatal = false;
    try {
      res = await processOne(candidates[i], i + 1, derive, payWallet);
    } catch (e) {
      console.log('❌ Fail:', e.shortMessage || e.message);
      res = { index: candidates[i].index, status: 'failed', reason: e.message };
      if (e.message.includes('PAY wallet me BNB kam')) {
        console.log('⛔ PAY BNB khatam - baaki wallets skip');
        fatal = true;
      }
    }
    results.push(res);
    if (fatal) break;
  }

  const ok = results.filter((r) => r.status === 'ok');
  const failed = results.filter((r) => r.status === 'failed');
  const skipped = results.filter((r) => r.status === 'skipped');
  const totalWithdrawn = ok.reduce((s, r) => s + parseFloat(r.amount), 0);
  const notTried = candidates.length - results.length;

  console.log(`\n---- Summary ----`);
  console.log(`Processed : ${results.length}/${candidates.length}${notTried ? ` (${notTried} baaki)` : ''}`);
  console.log(`✅ Success : ${ok.length} | ❌ Fail: ${failed.length} | ⏭ Skip: ${skipped.length}`);
  console.log(`💸 Total withdraw : ${totalWithdrawn.toFixed(6)} USDT -> ${WITHDRAW_TO}`);
  if (failed.length) {
    console.log('❌ Fail list:');
    for (const f of failed) console.log(`   index ${f.index}: ${f.reason}`);
  }
  if (ok.length) {
    console.log('✅ Done list:');
    for (const r of ok) console.log(`   index ${r.index}: ${r.amount} USDT`);
  }
  console.log(`⏱ Total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  rl.close();
}

main().catch((e) => {
  console.error('❌ Fail:', e.message);
  process.exit(1);
});
