/**
 * Klaim **fee creator** (0.06% per swap) dari pool Virtual Liquidity AMM.
 *
 * Fee swap 0.30% dipecah menjadi 0.24% untuk LP dan 0.06% untuk pembuat pool.
 * Bagian creator menumpuk di dua akun on-chain `fee_vault_x` / `fee_vault_y`
 * (PDA milik `pool_state`) dan hanya bisa ditarik oleh wallet `creator` melalui
 * instruksi `claim_creator_fee` (discriminator `u8 = 3`, payload 10 B).
 *
 * Pemakaian:
 *   npm run claim:creator -- --pool <POOL_PDA>                 # cek (dry-run)
 *   npm run claim:creator -- --pool <POOL_PDA> --execute       # kirim transaksi
 *   npm run claim:creator -- --pool <POOL_PDA> --side y        # hanya sisi token
 *   npm run claim:creator -- --pool <POOL_PDA> --min 0.001      # batas minimal (SOL)
 *
 * Opsi:
 *   --pool <pubkey>     PDA pool state (wajib)
 *   --keypair <path>    wallet creator (default: $ANCHOR_WALLET atau ~/.config/solana/id.json)
 *   --rpc <url>         RPC endpoint (default: $VITE_RPC_ENDPOINT atau devnet publik)
 *   --side both|x|y     sisi yang diklaim (default: both)
 *   --min <jumlah>      minimal fee terakumulasi per sisi (default: 0)
 *   --execute           benar-benar mengirim transaksi (default: dry-run + simulate)
 *   --no-simulate       lewati simulasi preflight
 *   --help              bantuan
 *
 * Catatan: script ini TIDAK memegang secret apa pun selain file keypair lokal,
 * dan hanya membaca `PoolState` + dua fee vault dari RPC.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  ClaimSide,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  DEFAULT_TOKEN_DECIMALS,
  DeserializedPoolInfo,
  formatTokenAmount,
  parseTokenAmount,
} from '../src/sdk/customSdk';

// ============================================================================
// KONSTANTA & TIPE
// ============================================================================

export const DEFAULT_RPC_ENDPOINT = 'https://api.devnet.solana.com';

/** Lama (detik) menunggu konfirmasi transaksi claim. */
export const CONFIRM_TIMEOUT_MS = 60_000;

export interface ClaimCliArgs {
  pool?: string;
  keypair: string;
  rpc: string;
  side: ClaimSide;
  minAmountRaw: bigint;
  execute: boolean;
  simulate: boolean;
  help: boolean;
}

export interface ClaimRunResult {
  pool: PublicKey;
  creator: PublicKey;
  claimableX: bigint;
  claimableY: bigint;
  claimedX: bigint;
  claimedY: bigint;
  side: ClaimSide;
  signature?: string;
  explorerUrl?: string;
  simulated: boolean;
}

// ============================================================================
// PARSING ARGUMEN
// ============================================================================

export function parseClaimSide(value: string): ClaimSide {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'both' || normalized === '0') return 'BOTH';
  if (normalized === 'x' || normalized === '1' || normalized === 'sol') return 'X';
  if (normalized === 'y' || normalized === '2' || normalized === 'token') return 'Y';
  throw new Error(`--side tidak dikenal: "${value}" (pilih: both, x, y)`);
}

export function defaultKeypairPath(): string {
  const fromEnv = process.env.ANCHOR_WALLET ?? process.env.SOLANA_WALLET;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return join(homedir(), '.config', 'solana', 'id.json');
}

export function defaultRpcEndpoint(): string {
  const fromEnv = process.env.VITE_RPC_ENDPOINT;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : DEFAULT_RPC_ENDPOINT;
}

export function parseArgs(argv: string[]): ClaimCliArgs {
  const args: ClaimCliArgs = {
    keypair: defaultKeypairPath(),
    rpc: defaultRpcEndpoint(),
    side: 'BOTH',
    minAmountRaw: 0n,
    execute: false,
    simulate: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Nilai untuk ${flag} tidak ditemukan`);
      }
      i++;
      return value;
    };

    switch (flag) {
      case '--pool':
        args.pool = next();
        break;
      case '--keypair':
        args.keypair = next();
        break;
      case '--rpc':
        args.rpc = next();
        break;
      case '--side':
        args.side = parseClaimSide(next());
        break;
      case '--min':
        args.minAmountRaw = parseTokenAmount(next(), DEFAULT_TOKEN_DECIMALS);
        break;
      case '--execute':
        args.execute = true;
        break;
      case '--dry-run':
        args.execute = false;
        break;
      case '--no-simulate':
        args.simulate = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (flag.startsWith('--')) {
          throw new Error(`Flag tidak dikenal: ${flag}`);
        }
        if (!args.pool) {
          args.pool = flag; // posisi pertama boleh berupa pubkey pool
        } else {
          throw new Error(`Argumen tidak dikenal: ${flag}`);
        }
    }
  }

  return args;
}

// ============================================================================
// HELPER KEYPAIR & VALIDASI
// ============================================================================

export function loadKeypair(path: string): Keypair {
  const abs = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(abs)) {
    throw new Error(
      `File keypair tidak ditemukan: ${abs}. Buat dengan "solana-keygen new -o ${abs}" ` +
        'atau tunjuk file lain lewat --keypair.'
    );
  }
  const raw = readFileSync(abs, 'utf8');
  let secret: number[];
  try {
    secret = JSON.parse(raw) as number[];
  } catch {
    throw new Error(
      `Isi ${abs} bukan JSON keypair Solana (harus array 64 byte). ` +
        'Jangan memakai file seed phrase.'
    );
  }
  if (!Array.isArray(secret) || secret.length !== 64) {
    throw new Error(`Keypair ${abs} tidak valid: panjang secret harus 64 byte.`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function parsePoolAddress(value: string): PublicKey {
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(
      `--pool bukan pubkey valid: "${value}". Pakai alamat PDA pool (bukan URL explorer).`
    );
  }
}

/** Fee yang benar-benar bisa diklaim untuk `side` yang dipilih. */
export function resolveClaimable(
  info: DeserializedPoolInfo,
  side: ClaimSide
): { x: bigint; y: bigint } {
  return {
    x: side === 'BOTH' || side === 'X' ? info.creatorFeeX : 0n,
    y: side === 'BOTH' || side === 'Y' ? info.creatorFeeY : 0n,
  };
}

export function assertIsCreator(info: DeserializedPoolInfo, wallet: PublicKey): void {
  if (!info.creator.equals(wallet)) {
    throw new Error(
      `Wallet ${wallet.toBase58()} bukan creator pool ini.\n` +
        `Creator sebenarnya: ${info.creator.toBase58()} — jalankan script dengan keypair tersebut ` +
        '(mis. `--keypair ~/.config/solana/id.json`).'
    );
  }
}

// ============================================================================
// INTI: BACA POOL -> SUSUN TRANSAKSI -> (OPSIONAL) KIRIM
// ============================================================================

export interface RunClaimOptions {
  connection: Connection;
  keypair: Keypair;
  pool: PublicKey;
  side?: ClaimSide;
  /** Minimal fee terakumulasi per sisi (raw, 9 desimal). Default 0 */
  minAmountRaw?: bigint;
  execute?: boolean;
  simulate?: boolean;
  recentBlockhash?: string;
  /** Batas waktu konfirmasi (ms) — dipakai tes agar tidak menunggu 60 detik */
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
  log?: (line: string) => void;
}

export async function runClaimCreator(
  options: RunClaimOptions
): Promise<ClaimRunResult> {
  const {
    connection,
    keypair,
    pool,
    side = 'BOTH',
    minAmountRaw = 0n,
    execute = false,
    simulate = true,
    recentBlockhash,
    log = () => undefined,
  } = options;

  const sdk = new CustomDefiSDK(connection, DEFAULT_AMM_PROGRAM_ID);
  const info = await sdk.fetchPoolInfo(pool);
  assertIsCreator(info, keypair.publicKey);

  const claimable = resolveClaimable(info, side);

  if (claimable.x === 0n && claimable.y === 0n) {
    throw new Error(
      'Belum ada fee creator yang terakumulasi pada sisi yang dipilih. ' +
        'Fee 0.06% baru terisi setelah ada swap di pool ini.'
    );
  }

  const claim = await sdk.buildClaimCreatorFeeTx({
    creator: keypair.publicKey,
    tokenX: info.tokenX,
    tokenY: info.tokenY,
    side,
    minAmount: minAmountRaw,
    ...(recentBlockhash ? { recentBlockhash } : {}),
  });

  const result: ClaimRunResult = {
    pool,
    creator: info.creator,
    claimableX: claimable.x,
    claimableY: claimable.y,
    claimedX: claimable.x,
    claimedY: claimable.y,
    side,
    simulated: false,
  };

  log(
    `Pool    : ${pool.toBase58()}\n` +
      `Creator : ${info.creator.toBase58()}\n` +
      `Fee X   : ${formatTokenAmount(claimable.x, DEFAULT_TOKEN_DECIMALS, 6)} SOL (WSOL)\n` +
      `Fee Y   : ${formatTokenAmount(claimable.y, DEFAULT_TOKEN_DECIMALS, 6)} token\n` +
      `Sisi    : ${side}`
  );

  if (simulate) {
    const simulation = await connection.simulateTransaction(claim.transaction);
    if (simulation.value.err) {
      const logs = (simulation.value.logs ?? []).slice(-4).join(' | ');
      throw new Error(
        `Simulasi claim_creator_fee gagal: ${JSON.stringify(simulation.value.err)}` +
          (logs ? `\nLog terakhir: ${logs}` : '')
      );
    }
    result.simulated = true;
    log('Simulasi preflight: OK');
  }

  if (!execute) {
    log('Mode dry-run — tambahkan --execute untuk benar-benar mengirim transaksi.');
    return result;
  }

  claim.transaction.sign(keypair);
  const rawTx = claim.transaction.serialize();
  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  await confirmSignature(connection, signature, claim.transaction, {
    ...(options.confirmTimeoutMs !== undefined
      ? { timeoutMs: options.confirmTimeoutMs }
      : {}),
    ...(options.confirmPollMs !== undefined ? { pollMs: options.confirmPollMs } : {}),
  });
  result.signature = signature;
  result.explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  log(`Signature: ${signature}`);
  return result;
}

/** Jeda antar-polling status signature. */
export const CONFIRM_POLL_MS = 1_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Konfirmasi transaksi tanpa menggantung selamanya.
 *
 * Memakai polling `getSignatureStatuses` + `getBlockHeight` sendiri — bukan
 * `connection.confirmTransaction()` — supaya ada batas waktu eksplisit dan pesan
 * error yang jelas bila RPC tidak pernah mengembalikan status final.
 */
export interface ConfirmOptions {
  /** Total waktu tunggu (default `CONFIRM_TIMEOUT_MS`) */
  timeoutMs?: number;
  /** Jeda antar-polling (default `CONFIRM_POLL_MS`) */
  pollMs?: number;
}

export async function confirmSignature(
  connection: Connection,
  signature: string,
  transaction: Transaction,
  options: ConfirmOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? CONFIRM_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CONFIRM_POLL_MS;
  const latest = await connection.getLatestBlockhash('confirmed');
  const lastValidBlockHeight =
    typeof transaction.lastValidBlockHeight === 'number'
      ? transaction.lastValidBlockHeight
      : latest.lastValidBlockHeight;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(
          `Transaksi ${signature} gagal on-chain: ${JSON.stringify(status.err)}`
        );
      }
      if (
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
      ) {
        return;
      }
    }

    const blockHeight = await connection.getBlockHeight('confirmed');
    if (blockHeight > lastValidBlockHeight) {
      throw new Error(
        `Transaksi ${signature} kedaluwarsa (block height ${blockHeight} > ${lastValidBlockHeight}). Coba kirim ulang.`
      );
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Timeout ${(timeoutMs / 1000).toFixed(1)}s menunggu konfirmasi ${signature}. ` +
      'Cek statusnya di explorer sebelum mengirim ulang.'
  );
}

// ============================================================================
// CLI
// ============================================================================

export const HELP_TEXT = `
Klaim fee creator (0.06% per swap) dari pool Virtual Liquidity AMM.

Pemakaian:
  npm run claim:creator -- --pool <POOL_PDA> [opsi]

Opsi:
  --pool <pubkey>     PDA pool state (wajib)
  --keypair <path>    wallet creator (default: $ANCHOR_WALLET / ~/.config/solana/id.json)
  --rpc <url>         RPC endpoint (default: $VITE_RPC_ENDPOINT / ${DEFAULT_RPC_ENDPOINT})
  --side both|x|y     sisi yang diklaim (default: both)
  --min <jumlah>      minimal fee terakumulasi per sisi, mis. 0.001 (default: 0)
  --execute           kirim transaksi (default: dry-run + simulasi preflight)
  --no-simulate       lewati simulasi preflight
  --help              tampilkan bantuan ini

Contoh:
  npm run claim:creator -- --pool 4MMLhXNXnyEtA5inVcHGLXBrYcVUsWn8ko5ai7PnDbZC
  npm run claim:creator -- --pool 4MM... --execute --min 0.001
`.trim();

async function main(): Promise<void> {
  let args: ClaimCliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    console.error(HELP_TEXT);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!args.pool) {
    console.error('✗ Argumen --pool <PDA pool> wajib diisi.\n');
    console.error(HELP_TEXT);
    process.exitCode = 1;
    return;
  }

  try {
    // Validasi input murah lebih dulu, baru sentuh filesystem/jaringan.
    const pool = parsePoolAddress(args.pool);
    const keypair = loadKeypair(args.keypair);
    const connection = new Connection(args.rpc, 'confirmed');
    console.log(`RPC     : ${args.rpc}`);
    console.log(`Wallet  : ${keypair.publicKey.toBase58()}\n`);

    const result = await runClaimCreator({
      connection,
      keypair,
      pool,
      side: args.side,
      minAmountRaw: args.minAmountRaw,
      execute: args.execute,
      simulate: args.simulate,
      log: (line) => console.log(line),
    });

    console.log(
      `\n✓ ${result.signature ? 'Fee creator terklaim' : 'Fee creator siap diklaim'}` +
        ` — X: ${formatTokenAmount(result.claimedX, DEFAULT_TOKEN_DECIMALS, 6)} SOL,` +
        ` Y: ${formatTokenAmount(result.claimedY, DEFAULT_TOKEN_DECIMALS, 6)} token`
    );
    if (result.explorerUrl) {
      console.log(`Explorer: ${result.explorerUrl}`);
    }
  } catch (err) {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
