// withdraw.mjs
import 'dotenv/config';
import { ethers } from 'ethers';
import Bip39 from 'bip39';
import walletPkg from 'ethereumjs-wallet';
import readline from 'readline';

const { hdkey } = walletPkg;

// ============ Config ============
const MNEMONIC = process.env.WALLET_SECRET;

const NETWORKS = {
  BSC: {
    name: 'BSC',
    rpc: 'https://bsc-dataseed.binance.org/',
    chainId: 56,
    tokens: {
      USDT: '0x55d398326f99059ff775485246999027b3197955',
      USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    },
  },
  ETH: {
    name: 'Ethereum',
    rpc: 'https://eth.llamarpc.com',
    chainId: 1,
    tokens: {
      USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
  },
};

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ============ Mnemonic se wallet derive ============
async function deriveWallet(mnemonic, index) {
  const seed = await Bip39.mnemonicToSeed(mnemonic);
  const hdNode = hdkey.fromMasterSeed(seed);
  const node = hdNode.derivePath(`m/44'/60'/0'/0/${index}`);
  const privateKey = node.getWallet().getPrivateKey().toString('hex');
  return new ethers.Wallet('0x' + privateKey);
}

// ============ Native coin (BNB/ETH) bhejo ============
async function sendNative(wallet, provider, to, amount) {
  const tx = await wallet.connect(provider).sendTransaction({
    to,
    value: ethers.parseEther(amount),
  });
  console.log(`✅ Bhej diya! Hash: ${tx.hash}`);
  await tx.wait();
  console.log('✅ Confirm ho gaya');
}

// ============ Token (USDT/USDC) bhejo ============
async function sendToken(wallet, provider, tokenAddress, to, amount) {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet.connect(provider));
  const decimals = await contract.decimals();
  const tx = await contract.transfer(to, ethers.parseUnits(amount, decimals));
  console.log(`✅ Bhej diya! Hash: ${tx.hash}`);
  await tx.wait();
  console.log('✅ Confirm ho gaya');
}

// ============ Main ============
async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((r) => rl.question(q, r));

  console.log('\n🔐 Withdraw Tool');
  console.log('1. BSC (BNB / USDT / USDC)');
  console.log('2. Ethereum (ETH / USDT / USDC)');
  const netChoice = await ask('Network chuno (1/2): ');

  const netConfig = netChoice === '1' ? NETWORKS.BSC : NETWORKS.ETH;
  const provider = new ethers.JsonRpcProvider(netConfig.rpc);

  const index = parseInt(await ask('Wallet index daalo (0, 1, 2...): '));
  const wallet = await deriveWallet(MNEMONIC, index);
  console.log(`📍 Wallet address: ${wallet.address}`);

  console.log('\nAsset chuno:');
  console.log(`1. ${netConfig.name === 'BSC' ? 'BNB' : 'ETH'} (native)`);
  console.log('2. USDT');
  console.log('3. USDC');
  const asset = await ask('Option (1/2/3): ');

  const to = await ask('Receiver address: ');
  const amount = await ask('Amount: ');

  try {
    if (asset === '1') {
      await sendNative(wallet, provider, to, amount);
    } else if (asset === '2') {
      await sendToken(wallet, provider, netConfig.tokens.USDT, to, amount);
    } else if (asset === '3') {
      await sendToken(wallet, provider, netConfig.tokens.USDC, to, amount);
    }
  } catch (e) {
    console.error('❌ Fail:', e.message);
  }

  rl.close();
}

main();