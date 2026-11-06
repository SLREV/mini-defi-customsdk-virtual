/**
 * Uji `scripts/claimCreatorFee.ts` tanpa jaringan:
 *   - parsing argumen CLI (--pool/--side/--min/--execute/flag aneh)
 *   - pembacaan keypair & validasi pubkey pool
 *   - `runClaimCreator()` dry-run, guard "bukan creator", guard "belum ada fee"
 *   - jalur simulasi preflight yang gagal + jalur `--execute` (mocked RPC)
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountInfo,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  DEFAULT_TOKEN_DECIMALS,
  NATIVE_SOL_MINT,
  POOL_STATE_DISCRIMINATOR,
  POOL_STATE_SIZE,
  PoolStateLayout,
  SPL_MINT_ACCOUNT_LAYOUT,
  SPL_MINT_SIZE,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SPL_TOKEN_ACCOUNT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  parseTokenAmount,
} from '../src/sdk/customSdk';
import {
  ClaimCliArgs,
  assertIsCreator,
  loadKeypair,
  parseArgs,
  parseClaimSide,
  parsePoolAddress,
  resolveClaimable,
  runClaimCreator,
} from '../scripts/claimCreatorFee';

// ============================================================================
// MOCK CONNECTION (ledger biner in-memory, tanpa RPC)
// ============================================================================

class MockConnection extends Connection {
  public readonly ledger = new Map<string, AccountInfo<Buffer>>();
  public simulateResult: { err: unknown; logs: string[] } = { err: null, logs: [] };
  public sentRaw = 0;
  public confirmed = 0;
  public failOnChain = false;
  public pendingForever = false;
  public blockHeight = 1;

  constructor() {
    super('http://127.0.0.1:8899', 'confirmed');
    // Overload bawaan `Connection` terlalu spesifik untuk di-override langsung,
    // jadi implementasi mock dipasang lewat cast.
    this.simulateTransaction = (async () => ({
      context: { slot: 1 },
      value: { err: this.simulateResult.err, logs: this.simulateResult.logs },
    })) as unknown as Connection['simulateTransaction'];

    this.getSignatureStatuses = (async (signatures: string[]) => {
      this.confirmed += 1;
      return {
        context: { slot: 1 },
        value: signatures.map(() => ({
          slot: 1,
          confirmations: 1,
          err: this.failOnChain ? { InstructionError: [0, { Custom: 9 }] } : null,
          confirmationStatus: this.pendingForever ? 'processed' : 'confirmed',
        })),
      };
    }) as unknown as Connection['getSignatureStatuses'];

    this.getBlockHeight = (async () =>
      this.blockHeight) as unknown as Connection['getBlockHeight'];
  }

  public put(pubkey: PublicKey, data: Buffer, owner: PublicKey): void {
    this.ledger.set(pubkey.toBase58(), {
      data,
      executable: false,
      lamports: 2_039_280,
      owner,
      rentEpoch: 0,
    });
  }

  override async getAccountInfo(
    pubkey: PublicKey,
    _commitment?: Commitment
  ): Promise<AccountInfo<Buffer> | null> {
    return this.ledger.get(pubkey.toBase58()) ?? null;
  }

  override async getMultipleAccountsInfo(
    pubkeys: PublicKey[],
    _commitment?: Commitment
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return pubkeys.map((p) => this.ledger.get(p.toBase58()) ?? null);
  }

  override async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 9_999,
    };
  }

  override async sendRawTransaction(
    _raw: Uint8Array | Buffer,
    _opts?: unknown
  ): Promise<string> {
    this.sentRaw += 1;
    return Keypair.generate().publicKey.toBase58() + 'x'.repeat(24);
  }

}

// ============================================================================
// FIXTURE POOL
// ============================================================================

const TOKEN_DECIMALS = DEFAULT_TOKEN_DECIMALS;

function seedPool(
  conn: MockConnection,
  creator: PublicKey,
  tokenY: PublicKey,
  amounts: { feeX: bigint; feeY: bigint }
): {
  pool: PublicKey;
  feeVaultX: PublicKey;
  feeVaultY: PublicKey;
  vaultX: PublicKey;
  vaultY: PublicKey;
  lpMint: PublicKey;
} {
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from('amm_pool'), NATIVE_SOL_MINT.toBuffer(), tokenY.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );
  const [feeVaultX] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault_x'), pool.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );
  const [feeVaultY] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_vault_y'), pool.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );
  const [vaultX] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_x'), pool.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );
  const [vaultY] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault_y'), pool.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );
  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from('lp_mint'), pool.toBuffer()],
    DEFAULT_AMM_PROGRAM_ID
  );

  const poolBuf = Buffer.alloc(POOL_STATE_SIZE);
  PoolStateLayout.encode(
    {
      discriminator: POOL_STATE_DISCRIMINATOR,
      tokenX: NATIVE_SOL_MINT,
      tokenY,
      vaultX,
      vaultY,
      lpMint,
      creator,
      feeVaultX,
      feeVaultY,
      virtualReservesX: 30_000_000_000n,
      virtualReservesY: 0n,
      bump: 255,
    },
    poolBuf
  );
  conn.put(pool, poolBuf, DEFAULT_AMM_PROGRAM_ID);

  const tokenAccount = (mint: PublicKey, owner: PublicKey, amount: bigint): Buffer => {
    const buf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
    SPL_TOKEN_ACCOUNT_LAYOUT.encode(
      {
        mint,
        owner,
        amount,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      buf
    );
    return buf;
  };

  conn.put(vaultX, tokenAccount(NATIVE_SOL_MINT, pool, 5_000_000_000n), TOKEN_PROGRAM_ID);
  conn.put(vaultY, tokenAccount(tokenY, pool, 700_000_000_000_000_000n), TOKEN_2022_PROGRAM_ID);
  conn.put(feeVaultX, tokenAccount(NATIVE_SOL_MINT, pool, amounts.feeX), TOKEN_PROGRAM_ID);
  conn.put(feeVaultY, tokenAccount(tokenY, pool, amounts.feeY), TOKEN_2022_PROGRAM_ID);

  const lpBuf = Buffer.alloc(SPL_MINT_SIZE);
  SPL_MINT_ACCOUNT_LAYOUT.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: pool,
      supply: 1_000_000_000n,
      decimals: 9,
      isInitialized: 1,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    lpBuf
  );
  conn.put(lpMint, lpBuf, TOKEN_2022_PROGRAM_ID);

  return { pool, feeVaultX, feeVaultY, vaultX, vaultY, lpMint };
}

// ============================================================================
// TES
// ============================================================================

async function main(): Promise<void> {
  const creator = Keypair.generate();
  const stranger = Keypair.generate();
  const tokenY = Keypair.generate().publicKey;
  const conn = new MockConnection();
  const fixture = seedPool(conn, creator.publicKey, tokenY, {
    feeX: 3_000_000n, // 0.003 SOL
    feeY: 6_000_000_000n, // 6 token
  });

  // 1. Parsing argumen
  const args = parseArgs(['--pool', fixture.pool.toBase58()]);
  assert.equal(args.pool, fixture.pool.toBase58());
  assert.equal(args.side, 'BOTH');
  assert.equal(args.execute, false);
  assert.equal(args.simulate, true);
  assert.equal(args.minAmountRaw, 0n);

  const executed = parseArgs([
    fixture.pool.toBase58(), // posisi pertama boleh pubkey
    '--execute',
    '--side',
    'y',
    '--min',
    '0.001',
    '--rpc',
    'https://contoh-rpc.test',
  ]);
  assert.equal(executed.pool, fixture.pool.toBase58());
  assert.equal(executed.execute, true);
  assert.equal(executed.side, 'Y');
  assert.equal(executed.minAmountRaw, parseTokenAmount('0.001', TOKEN_DECIMALS));
  assert.equal(executed.rpc, 'https://contoh-rpc.test');

  assert.equal(parseArgs(['--pool', 'x', '--dry-run']).execute, false);
  assert.equal(parseArgs(['--pool', 'x', '--no-simulate']).simulate, false);
  assert.equal(parseArgs(['--help']).help, true);

  // Flag/nilai tidak valid harus ditolak dengan pesan jelas
  assert.throws(() => parseArgs(['--tidak-ada']), /Flag tidak dikenal/);
  assert.throws(() => parseArgs(['--pool']), /Nilai untuk --pool tidak ditemukan/);
  assert.throws(() => parseArgs(['--pool', 'a', '--side', 'z']), /--side tidak dikenal/);
  assert.throws(() => parseArgs(['--pool', 'a', 'b']), /Argumen tidak dikenal/);

  // 2. Alias sisi claim
  assert.equal(parseClaimSide('both'), 'BOTH');
  assert.equal(parseClaimSide('X'), 'X');
  assert.equal(parseClaimSide('sol'), 'X');
  assert.equal(parseClaimSide('token'), 'Y');
  assert.equal(parseClaimSide('2'), 'Y');

  // 3. Keypair: file hilang & isi bukan keypair
  const dir = mkdtempSync(join(tmpdir(), 'claim-creator-'));
  assert.throws(
    () => loadKeypair(join(dir, 'tidak-ada.json')),
    /File keypair tidak ditemukan/
  );
  const badPath = join(dir, 'bad.json');
  writeFileSync(badPath, '{"bukan":"keypair"}');
  assert.throws(() => loadKeypair(badPath), /bukan JSON keypair|tidak valid/);
  const goodPath = join(dir, 'good.json');
  writeFileSync(goodPath, JSON.stringify(Array.from(creator.secretKey)));
  assert.equal(loadKeypair(goodPath).publicKey.toBase58(), creator.publicKey.toBase58());

  // 4. Pubkey pool tidak valid
  assert.throws(() => parsePoolAddress('bukan-pubkey'), /--pool bukan pubkey valid/);
  assert.equal(
    parsePoolAddress(fixture.pool.toBase58()).toBase58(),
    fixture.pool.toBase58()
  );

  // 5. Baca pool dari ledger mock + guard "bukan creator"
  const sdk = new CustomDefiSDK(conn, DEFAULT_AMM_PROGRAM_ID);
  const info = await sdk.fetchPoolInfo(fixture.pool);
  assert.equal(info.creatorFeeX, 3_000_000n);
  assert.equal(info.creatorFeeY, 6_000_000_000n);
  assert.deepEqual(resolveClaimable(info, 'BOTH'), {
    x: 3_000_000n,
    y: 6_000_000_000n,
  });
  assert.deepEqual(resolveClaimable(info, 'X'), { x: 3_000_000n, y: 0n });
  assert.deepEqual(resolveClaimable(info, 'Y'), { x: 0n, y: 6_000_000_000n });
  assert.throws(() => assertIsCreator(info, stranger.publicKey), /bukan creator/);
  assertIsCreator(info, creator.publicKey);

  // 7. Dry-run: tidak mengirim apa pun, melaporkan nominal yang bisa diklaim
  const lines: string[] = [];
  const dryRun = await runClaimCreator({
    connection: conn,
    keypair: creator,
    pool: fixture.pool,
    simulate: false,
    log: (line) => lines.push(line),
  });
  assert.equal(dryRun.claimableX, 3_000_000n);
  assert.equal(dryRun.claimableY, 6_000_000_000n);
  assert.equal(dryRun.signature, undefined);
  assert.equal(conn.sentRaw, 0);
  assert.ok(lines.join('\n').includes('dry-run'));

  // Sisi Y saja
  const dryRunY = await runClaimCreator({
    connection: conn,
    keypair: creator,
    pool: fixture.pool,
    side: 'Y',
    simulate: false,
  });
  assert.equal(dryRunY.claimableX, 0n);
  assert.equal(dryRunY.claimableY, 6_000_000_000n);

  // 8. Guard "belum ada fee" (fee vault kosong)
  const emptyPool = seedPool(conn, creator.publicKey, Keypair.generate().publicKey, {
    feeX: 0n,
    feeY: 0n,
  });
  await assert.rejects(
    () =>
      runClaimCreator({
        connection: conn,
        keypair: creator,
        pool: emptyPool.pool,
        simulate: false,
      }),
    /Belum ada fee creator/
  );

  // 9. Simulasi preflight gagal -> error menyertakan log program
  conn.simulateResult = {
    err: { InstructionError: [0, { Custom: 6009 }] },
    logs: ['Program log: Instruction: ClaimCreatorFee', 'Program log: Error: NothingToClaim'],
  };
  await assert.rejects(
    () =>
      runClaimCreator({
        connection: conn,
        keypair: creator,
        pool: fixture.pool,
        simulate: true,
      }),
    /Simulasi claim_creator_fee gagal.*NothingToClaim/s
  );
  conn.simulateResult = { err: null, logs: [] };

  // 10. --execute: sign, kirim, konfirmasi, kembalikan signature + link explorer
  const executedRun = await runClaimCreator({
    connection: conn,
    keypair: creator,
    pool: fixture.pool,
    execute: true,
    simulate: true,
  });
  assert.equal(conn.sentRaw, 1);
  assert.equal(conn.confirmed, 1);
  assert.ok(executedRun.signature && executedRun.signature.length > 32);
  assert.match(
    executedRun.explorerUrl ?? '',
    /^https:\/\/explorer\.solana\.com\/tx\/.+cluster=devnet$/
  );

  // 11. Transaksi gagal on-chain -> error jelas
  conn.failOnChain = true;
  await assert.rejects(
    () =>
      runClaimCreator({
        connection: conn,
        keypair: creator,
        pool: fixture.pool,
        execute: true,
        simulate: false,
      }),
    /gagal on-chain/
  );
  conn.failOnChain = false;

  // 11b. Transaksi tidak pernah final -> timeout terkendali (bukan menggantung)
  conn.pendingForever = true;
  conn.blockHeight = 1;
  await assert.rejects(
    () =>
      runClaimCreator({
        connection: conn,
        keypair: creator,
        pool: fixture.pool,
        execute: true,
        simulate: false,
        confirmTimeoutMs: 60,
        confirmPollMs: 5,
      }),
    /Timeout 0\.1s menunggu konfirmasi/
  );
  // 11c. Block height melewati lastValidBlockHeight -> pesan kedaluwarsa
  conn.blockHeight = 100_000;
  await assert.rejects(
    () =>
      runClaimCreator({
        connection: conn,
        keypair: creator,
        pool: fixture.pool,
        execute: true,
        simulate: false,
        confirmTimeoutMs: 1_000,
        confirmPollMs: 5,
      }),
    /kedaluwarsa \(block height 100000 > 9999\)/
  );
  conn.pendingForever = false;
  conn.blockHeight = 1;

  // 12. CLI argumen lengkap (tanpa jaringan) tetap menghasilkan objek yang konsisten
  const cliArgs: ClaimCliArgs = parseArgs([
    '--pool',
    fixture.pool.toBase58(),
    '--keypair',
    goodPath,
    '--side',
    'both',
    '--min',
    '0.000001',
    '--execute',
  ]);
  assert.equal(cliArgs.execute, true);
  assert.equal(cliArgs.minAmountRaw, 1_000n);
  assert.equal(loadKeypair(cliArgs.keypair).publicKey.toBase58(), creator.publicKey.toBase58());

  console.log('ALL CLAIM CREATOR FEE TESTS PASSED!');
  console.log({
    pool: fixture.pool.toBase58(),
    feeVaultX: fixture.feeVaultX.toBase58(),
    feeVaultY: fixture.feeVaultY.toBase58(),
    claimableSol: '0.003',
    claimableToken: '6',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
