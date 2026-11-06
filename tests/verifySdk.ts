import assert from 'node:assert/strict';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  ADD_LIQUIDITY_IX_LAYOUT,
  CREATE_POOL_IX_LAYOUT,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  FEE_DENOMINATOR,
  FEE_NUMERATOR,
  LEVERAGE_MULTIPLIER,
  NATIVE_SOL_MINT,
  POOL_STATE_SIZE,
  PoolStateLayout,
  SWAP_IX_LAYOUT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  calculateInitialLpTokens,
  calculateSwapOutput,
} from '../src/sdk/customSdk';

class OfflineConnection extends Connection {
  constructor() { super('http://127.0.0.1:8899'); }
  override async getLatestBlockhash() {
    return { blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 };
  }
}

async function main(): Promise<void> {
  assert.equal(PoolStateLayout.span, 185);
  assert.equal(POOL_STATE_SIZE, 185);
  assert.equal(CREATE_POOL_IX_LAYOUT.span, 17);
  assert.equal(ADD_LIQUIDITY_IX_LAYOUT.span, 25);
  assert.equal(SWAP_IX_LAYOUT.span, 18);
  assert.equal(FEE_NUMERATOR, 3n);
  assert.equal(FEE_DENOMINATOR, 1_000n);
  assert.equal(LEVERAGE_MULTIPLIER, 10n);
  assert.equal(calculateInitialLpTokens(10_000n, 40_000n), 20_000n);

  const q = calculateSwapOutput(1_000_000n, 10_000_000n, 20_000_000n);
  const amountAfterFee = 1_000_000n * 997n;
  assert.equal(q, amountAfterFee * 20_000_000n / (10_000_000n * 1_000n + amountAfterFee));

  const sdk = new CustomDefiSDK(new OfflineConnection(), DEFAULT_AMM_PROGRAM_ID);
  const payer = Keypair.generate().publicKey;
  const mintY = Keypair.generate().publicKey;
  const deposit = 1_250_000_000n;
  const init = await sdk.buildCreatePoolTx({
    payer,
    tokenX: NATIVE_SOL_MINT,
    tokenY: mintY,
    initialRealTokenY: 500_000_000_000_000n,
    realSolDeposited: deposit,
    tokenProgramX: TOKEN_PROGRAM_ID,
    tokenProgramY: TOKEN_2022_PROGRAM_ID,
    tokenProgramLp: TOKEN_2022_PROGRAM_ID,
  });
  assert.equal(init.instruction.keys.length, 16);
  const initData = CREATE_POOL_IX_LAYOUT.decode(init.serializedIxData);
  assert.equal(initData.discriminator, 0);
  assert.equal(initData.realSolDeposited, deposit);
  assert.equal(init.expectedInitialLp, calculateInitialLpTokens(deposit * 10n, 500_000_000_000_000n));
  // ATA X + ATA Y + native SOL wrap (transfer + SyncNative) + initialize.
  assert.equal(init.transaction.instructions.length, 5);
  assert.equal(init.userTokenX.toBase58(), sdk.deriveAssociatedTokenAddress(payer, NATIVE_SOL_MINT, TOKEN_PROGRAM_ID).toBase58());

  const swap = await sdk.buildSwapTx({
    user: payer,
    tokenX: NATIVE_SOL_MINT,
    tokenY: mintY,
    amountIn: 100_000_000n,
    minAmountOut: 1n,
    xToY: true,
    tokenProgramX: TOKEN_PROGRAM_ID,
    tokenProgramY: TOKEN_2022_PROGRAM_ID,
  });
  assert.equal(swap.instruction.keys.length, 10);
  assert.equal(SWAP_IX_LAYOUT.decode(swap.serializedIxData).discriminator, 2);
  assert.equal(swap.transaction.instructions.at(-1)?.keys.length, 10);

  console.log('✅ Leveraged AMM SDK layouts, 10x initialization, WSOL funding, and 30 bps quote verified.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
