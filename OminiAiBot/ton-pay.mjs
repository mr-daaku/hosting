// ton-pay.mjs - TON USDT pay script: receiver + amount daalo -> WalletV5r1 se USDT jetton transfer (TonCenter API)
import 'dotenv/config';
import readline from 'readline';
import crypto from 'crypto';
import tonCrypto from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, internal, external, storeMessage, SendMode } from '@ton/core';

const { getED25519MasterKeyFromSeed, deriveED25519HardenedKey, keyPairFromSeed } = tonCrypto;

// ============ Config ============
const RPC = 'https://toncenter.com/api/v2/jsonRPC';
const API_KEY = process.env.TON_CENTER_API;
const PHRASE = process.env.TON_WALLET_SECRET;
const EXPECTED_WALLET = 'UQClwv5NDfVBCgKvI3ngXTFR3KDClEIMtYGfv04AM9YZhiUz';
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const JETTON_OP = 0x0f8a7ea5; // TEP-74 transfer op
const MEMO = 'OminixAiBot'; // har payment ke saath jaane wala comment
const MSG_VALUE = 30000000n; // 0.03 TON jetton wallet ko (gas + forward, excess wapas)
const FORWARD_TON = 2000000n; // 0.002 TON receiver ko notification (memo dikhne ke liye >0 chahiye)
const MIN_TON = 40000000n; // send se pehle kam se kam 0.04 TON chahiye

if (!API_KEY || !PHRASE) {
  console.error('❌ .env me TON_CENTER_API / TON_WALLET_SECRET nahi hai');
  process.exit(1);
}

// ============ TonCenter JSON-RPC helper ============
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ id: '1', jsonrpc: '2.0', method, params }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || 'rpc fail');
  return j.result;
}

function stackNum(entry) {
  if (!entry || entry[0] !== 'num') throw new Error('stack me num nahi: ' + JSON.stringify(entry));
  return BigInt(entry[1]);
}

// ============ Wallet derive: BIP39 seed -> SLIP-10 ed25519 -> m/44'/607'/0' -> V5r1 ============
async function deriveWallet(phrase) {
  const bip39Seed = crypto.pbkdf2Sync(phrase.trim(), 'mnemonic', 2048, 64, 'sha512');
  let st = await getED25519MasterKeyFromSeed(bip39Seed);
  for (const idx of [44, 607, 0]) st = await deriveED25519HardenedKey(st, idx);
  const kp = keyPairFromSeed(st.key);
  const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: kp.publicKey });
  return { wallet, secretKey: kp.secretKey };
}

// ============ Amount helpers (USDT = decimals per jetton) ============
function parseAmount(input, decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(input).trim());
  if (!m) return null;
  const frac = m[2] || '';
  if (frac.length > decimals) return null;
  const nano = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return nano > 0n ? nano : null;
}

function fmtAmount(nano, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = nano / base;
  const frac = (nano % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ============ Balances ============
async function getJettonWallet(ownerAddr) {
  const sliceBoc = beginCell().storeAddress(ownerAddr).endCell().toBoc().toString('base64');
  const res = await rpc('runGetMethod', { address: USDT_MASTER, method: 'get_wallet_address', stack: [['tvm.Slice', sliceBoc]] });
  const entry = res.stack[0];
  if (!entry || entry[0] !== 'cell') throw new Error('jetton wallet addr nahi mila');
  return Cell.fromBoc(Buffer.from(entry[1].bytes, 'base64'))[0].beginParse().loadAddress();
}

async function getBalances(state) {
  const info = await rpc('getAddressInformation', { address: state.wallet.address.toString() });
  const ton = BigInt(info.balance);
  let usdt = 0n;
  try {
    const data = await rpc('runGetMethod', { address: state.jettonWallet.toString(), method: 'get_wallet_data', stack: [] });
    usdt = stackNum(data.stack[0]);
  } catch {
    usdt = 0n; // jetton wallet bana hi nahi (kabhi USDT receive nahi kiya)
  }
  return { ton, usdt };
}

async function getSeqno(addr) {
  const res = await rpc('runGetMethod', { address: addr.toString(), method: 'seqno', stack: [] });
  return Number(stackNum(res.stack[0]));
}

async function getUsdtDecimals() {
  const r = await fetch(`https://toncenter.com/api/v2/getTokenData?address=${USDT_MASTER}`, { headers: { 'X-API-Key': API_KEY } });
  const j = await r.json();
  const dec = j?.ok ? Number(j.result?.jetton_content?.data?.decimals) : NaN;
  return Number.isInteger(dec) && dec >= 0 && dec <= 18 ? dec : 6;
}

// ============ Jetton transfer banao (TEP-74, memo comment ke saath) ============
function buildPaymentBody(dest, amount, decimals, ownerAddr) {
  const comment = beginCell().storeUint(0, 32).storeStringTail(MEMO).endCell(); // 0x00000000 = text comment
  return beginCell()
    .storeUint(JETTON_OP, 32)
    .storeUint(0, 64) // query_id
    .storeCoins(amount) // USDT nano
    .storeAddress(dest)
    .storeAddress(ownerAddr) // response_destination: excess yahin wapas
    .storeBit(0) // custom_payload nahi
    .storeCoins(FORWARD_TON) // >0 tabhi receiver ko notification (memo) jaayega
    .storeBit(1) // forward_payload as ref
    .storeRef(comment)
    .endCell();
}

// ============ Main (loop) ============
async function main() {
  console.log('\n⏳ Wallet derive ho raha hai (BIP39 -> m/44\'/607\'/0\' -> V5r1)...');
  const { wallet, secretKey } = await deriveWallet(PHRASE);
  const myAddr = wallet.address.toString({ urlSafe: true, bounceable: false });
  if (!wallet.address.equals(Address.parse(EXPECTED_WALLET))) {
    console.error('❌ Derived address match nahi karta!');
    console.error('   derived : ' + myAddr);
    console.error('   expected: ' + EXPECTED_WALLET);
    process.exit(1);
  }

  const state = {
    wallet,
    secretKey,
    ownerAddr: wallet.address,
    decimals: await getUsdtDecimals(),
    jettonWallet: await getJettonWallet(Address.parse(myAddr)),
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  let bal = await getBalances(state);
  console.log('\n💸 TON USDT Pay (loop)');
  console.log(`🏦 Asset   : USDT (jetton, ${state.decimals} decimals)`);
  console.log(`👛 Wallet  : ${myAddr}`);
  console.log(`📬 Jettons : ${state.jettonWallet.toString()}`);
  console.log(`💼 TON     : ${fmtAmount(bal.ton, 9)}`);
  console.log(`💼 USDT    : ${fmtAmount(bal.usdt, state.decimals)}`);

  while (true) {
    const receiverRaw = (await ask('\nReceiver address daalo (UQ/EQ... | q=exit): ')).trim();
    if (/^q$/i.test(receiverRaw)) break;

    let receiver;
    try {
      receiver = Address.parse(receiverRaw);
    } catch {
      console.log('❌ Address galat hai - TON address daalo (UQ... ya EQ...)');
      continue;
    }

    const amountRaw = (await ask(`Amount daalo (USDT, max ${fmtAmount(bal.usdt, state.decimals)} | q=exit): `)).trim();
    if (/^q$/i.test(amountRaw)) break;

    const amount = parseAmount(amountRaw, state.decimals);
    if (!amount) {
      console.log(`❌ Amount galat hai - >0 chahiye aur max ${state.decimals} decimal places`);
      continue;
    }
    if (amount > bal.usdt) {
      console.log(`❌ USDT kam hai - balance ${fmtAmount(bal.usdt, state.decimals)} USDT`);
      continue;
    }
    if (bal.ton < MIN_TON) {
      console.log(`❌ TON fee ke liye kam hai - ${fmtAmount(bal.ton, 9)} TON (min ${fmtAmount(MIN_TON, 9)} chahiye)`);
      continue;
    }

    console.log('\n---- Summary ----');
    console.log(`From : ${myAddr}`);
    console.log(`To   : ${receiver.toString()}`);
    console.log(`Amt  : ${fmtAmount(amount, state.decimals)} USDT`);
    console.log(`Memo : ${MEMO}`);
    console.log(`Fee  : ~0.005 TON (refund excess ke saath wapas)`);

    const ok = (await ask('Pay karu? (y/n): ')).trim().toLowerCase();
    if (ok !== 'y' && ok !== 'yes') {
      console.log('⚪ Cancel kiya');
      bal = await getBalances(state);
      continue;
    }

    try {
      const seqno = await getSeqno(state.ownerAddr);
      const body = buildPaymentBody(receiver, amount, state.decimals, state.ownerAddr);
      const msg = internal({ to: state.jettonWallet, value: MSG_VALUE, body });

      const signed = wallet.createTransfer({
        seqno,
        secretKey: state.secretKey,
        messages: [msg],
        sendMode: SendMode.PAY_GAS_SEPARATELY,
      });

      // createTransfer sirf wallet body deta hai - external message envelope yahan lagta hai
      const ext = external({ to: state.ownerAddr, body: signed });
      const boc = beginCell().store(storeMessage(ext)).endCell().toBoc().toString('base64');

      console.log(`\n⏳ Sending (seqno ${seqno})...`);
      const res = await rpc('sendBoc', { boc });
      const hash = res && typeof res === 'object' ? (res.hash || res.msg_hash || res.message?.hash) : (typeof res === 'string' ? res : null);

      await new Promise((r) => setTimeout(r, 3000));
      const newSeqno = await getSeqno(state.ownerAddr);
      bal = await getBalances(state);

      if (newSeqno > seqno) {
        console.log(`\n✅ paid | ${fmtAmount(amount, state.decimals)} USDT -> ${receiver.toString()}`);
        if (hash) console.log(`🔗 hash: ${hash}`);
        else if (res !== undefined && res !== null) console.log(`📨 response: ${JSON.stringify(res).slice(0, 200)}`);
      } else {
        console.log('\n⚠️ Broadcast accept hua par seqno abhi update nahi - thoda wait karke balance check karo');
        if (hash) console.log(`🔗 hash: ${hash}`);
      }
      console.log(`💼 TON  : ${fmtAmount(bal.ton, 9)}`);
      console.log(`💼 USDT : ${fmtAmount(bal.usdt, state.decimals)}`);
    } catch (e) {
      console.error('❌ Send fail:', e.message);
      try { bal = await getBalances(state); } catch {}
    }
  }

  rl.close();
  console.log('👋 Bye');
}

main().catch((e) => {
  console.error('❌ Fail:', e.message);
  process.exit(1);
});
