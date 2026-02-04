require('dotenv').config();
const {
  createPublicClient,
  http,
  parseAbiItem,
  formatUnits,
  parseAbi,
} = require('viem');
const { bsc } = require('viem/chains');

// --- CONFIGURATION ---
const RPC_URL = 'https://binance.llamarpc.com';
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

// Tumhara AutoCollector Contract Address
const MY_CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// Kitne pichle blocks scan karne hain? (Public RPC limit: ~5000-10000 blocks safely)
const BLOCKS_TO_SCAN = 1000n;

async function main() {
  if (!MY_CONTRACT_ADDRESS) {
    console.error('❌ Error: .env file mein CONTRACT_ADDRESS missing hai.');
    return;
  }

  console.log('🔍 Connecting to BSC via Viem...');

  const client = createPublicClient({
    chain: bsc,
    transport: http(RPC_URL),
  });

  // 1. Current Block Pata Karo
  const currentBlock = await client.getBlockNumber();
  const fromBlock = currentBlock - BLOCKS_TO_SCAN;

  console.log(`📡 Scanning from Block ${fromBlock} to ${currentBlock}`);
  console.log(`🎯 Target Spender: ${MY_CONTRACT_ADDRESS}`);

  // 2. Logs Fetch Karo (Past Approvals)
  // Viem mein hum seedha ABI event likh kar filter kar sakte hain
  console.log('⏳ Fetching logs... (Wait karein)');

  try {
    const logs = await client.getLogs({
      address: USDT_ADDRESS,
      event: parseAbiItem(
        'event Approval(address indexed owner, address indexed spender, uint256 value)'
      ),
      args: {
        spender: MY_CONTRACT_ADDRESS, // Sirf wo logs jisme spender humara contract hai
      },
      fromBlock: fromBlock,
      toBlock: currentBlock,
    });

    console.log(`✅ Found ${logs.length} approval events.`);

    // 3. Unique Users Nikalo
    const uniqueUsers = new Set();
    logs.forEach((log) => {
      uniqueUsers.add(log.args.owner);
    });

    console.log(`👥 Unique Users Found: ${uniqueUsers.size}\n`);

    // 4. Live Status Check Karo (Multicall Logic manually)
    console.log('--- 📊 FINAL REPORT ---');
    console.log(
      'User Address                               | Approved Amount    | Current USDT Balance'
    );
    console.log('-'.repeat(85));

    const USDT_ABI = parseAbi([
      'function allowance(address owner, address spender) view returns (uint256)',
      'function balanceOf(address account) view returns (uint256)',
    ]);

    for (const user of uniqueUsers) {
      try {
        // Parallel me dono data mangwa lo (Fast)
        const [allowance, balance] = await Promise.all([
          client.readContract({
            address: USDT_ADDRESS,
            abi: USDT_ABI,
            functionName: 'allowance',
            args: [user, MY_CONTRACT_ADDRESS],
          }),
          client.readContract({
            address: USDT_ADDRESS,
            abi: USDT_ABI,
            functionName: 'balanceOf',
            args: [user],
          }),
        ]);

        // Formatting
        const balFmt = parseFloat(formatUnits(balance, 18)).toFixed(2);
        let allowFmt = '0';

        if (allowance > 0n) {
          // Check for Unlimited (Very large number)
          if (allowance > 1000000000000000000000000n) {
            // > 1 Million USDT approx
            allowFmt = 'UNLIMITED ♾️';
          } else {
            allowFmt =
              parseFloat(formatUnits(allowance, 18)).toFixed(2) + ' USDT';
          }

          // Output Print
          console.log(`${user} | ${allowFmt.padEnd(18)} | ${balFmt} USDT`);
        } else {
          console.log(`${user} | 0 (Revoked)        | ${balFmt} USDT`);
        }
      } catch (e) {
        console.log(`${user} | Error fetching data`);
      }
    }
    console.log('-'.repeat(85));
  } catch (error) {
    console.error('❌ Error Scanning:', error.message);
    console.log(
      "Tip: Agar 'Limit Exceeded' error aaye to BLOCKS_TO_SCAN kam kar dena."
    );
  }
}

main();
