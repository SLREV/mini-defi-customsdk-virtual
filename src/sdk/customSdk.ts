import {
  AccountMeta,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import * as BufferLayout from '@solana/buffer-layout';

// ============================================================================
// KONSTANTA PROGRAM SOLANA & TOKEN-2022 (MURNI TANPA SDK PIHAK KETIGA)
// ============================================================================

export const DEFAULT_AMM_PROGRAM_ID = new PublicKey(
  'Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp'
);

/** SPL Token Legacy Program (digunakan oleh WSOL & USDC lama) */
export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);

/** SPL Token-2022 (Token Extensions) Program */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

export const METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

export const NATIVE_SOL_MINT = new PublicKey(
  'So11111111111111111111111111111111111111112'
);

export const DEVNET_USDC_MINT = new PublicKey(
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
);

export const DEFAULT_TOKEN_DECIMALS = 9;

export const SPL_MINT_SIZE = 82;
export const SPL_TOKEN_ACCOUNT_SIZE = 165;

/**
 * Ukuran dasar akun Mint Token-2022 dengan ekstensi `MetadataPointer`:
 * 165B (padded base) + 1B (AccountType::Mint = 1) + 4B (TLV Header) + 64B (MetadataPointer) = 234 bytes
 */
export const TOKEN_2022_MINT_METADATA_POINTER_SIZE = 234;

/**
 * Stempel versi layout instruksi SDK. Ditampilkan di header dashboard supaya
 * bisa dipastikan browser benar-benar menjalankan kode terbaru (bukan bundle lama),
 * mis. setelah perbaikan layout `MintToChecked` (3 akun, bukan 4).
 */
export const SDK_BUILD_TAG = '2026.11.06 · leveraged10x · fee=30bps';

/**
 * Ukuran akun `PoolState` di `programs/mini-amm/src/lib.rs`:
 * 8B discriminator + 5 * 32B Pubkeys + 2 * 8B u64 + 1B bump = 185 bytes
 */
export const POOL_STATE_SIZE = 185;

/** Biaya swap 0.30%; fee dipertahankan di pool. */
export const FEE_NUMERATOR = 3n;
export const FEE_DENOMINATOR = 1_000n;
export const LEVERAGE_MULTIPLIER = 10n;

/** sha256("account:PoolState")[0..8] */
export const POOL_STATE_DISCRIMINATOR = Uint8Array.from([
  247, 237, 227, 245, 215, 195, 222, 70,
]);

/** sha256("spl_token_metadata_interface:initialize_account")[0..8] */
export const TOKEN_METADATA_INITIALIZE_DISCRIMINATOR = Uint8Array.from([
  210, 225, 30, 162, 88, 184, 77, 141,
]);

/** sha256("spl_token_metadata_interface:updating_field")[0..8] */
export const TOKEN_METADATA_UPDATE_FIELD_DISCRIMINATOR = Uint8Array.from([
  221, 233, 49, 45, 181, 202, 220, 200,
]);

const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export const AMM_IX_DISCRIMINATOR = {
  INITIALIZE_POOL: 0,
  ADD_LIQUIDITY: 1,
  SWAP: 2,
} as const;

const SPL_TOKEN_IX = {
  INITIALIZE_MINT: 0,
  CLOSE_ACCOUNT: 9,
  MINT_TO_CHECKED: 14,
  SYNC_NATIVE: 17,
  INITIALIZE_MINT2: 20,
  METADATA_POINTER_EXTENSION: 39,
} as const;

const METAPLEX_CREATE_METADATA_V3_IX = 33;

// ============================================================================
// CUSTOM @solana/buffer-layout PRIMITIVES (PUBKEY 32B & LOSSLESS U64 8B)
// ============================================================================

export class PublicKeyLayout extends BufferLayout.Layout<PublicKey> {
  private readonly rawBlob: BufferLayout.Blob;

  constructor(property?: string) {
    super(32, property);
    this.rawBlob = BufferLayout.blob(32);
  }

  override decode(b: Uint8Array, offset = 0): PublicKey {
    return new PublicKey(this.rawBlob.decode(b, offset));
  }

  override encode(src: PublicKey, b: Uint8Array, offset = 0): number {
    return this.rawBlob.encode(src.toBytes(), b, offset);
  }
}

/**
 * Layout 64-bit unsigned little-endian berbasis `@solana/buffer-layout`.
 * Memakai `BufferLayout.nu64` untuk angka aman IEEE-754 (`<= 2^53 - 1`) dan otomatis
 * beralih ke `DataView` BigInt 64-bit penuh untuk suplai token 9 desimal (`10^18` > `2^53 - 1`).
 */
export class U64Layout extends BufferLayout.Layout<bigint> {
  private readonly nearU64: BufferLayout.NearUInt64;

  constructor(property?: string) {
    super(8, property);
    this.nearU64 = BufferLayout.nu64();
  }

  override decode(b: Uint8Array, offset = 0): bigint {
    if (offset < 0 || offset + 8 > b.byteLength) {
      throw new RangeError(`Buffer underflow decoding u64 at offset ${offset}`);
    }
    return new DataView(b.buffer, b.byteOffset + offset, 8).getBigUint64(0, true);
  }

  override encode(src: bigint, b: Uint8Array, offset = 0): number {
    if (typeof src !== 'bigint' || src < 0n || src > MAX_U64) {
      throw new RangeError(`u64 value out of bounds [0, 2^64 - 1]: ${String(src)}`);
    }
    if (offset < 0 || offset + 8 > b.byteLength) {
      throw new RangeError(`Buffer overflow encoding u64 at offset ${offset}`);
    }
    if (src <= MAX_SAFE_BIGINT) {
      return this.nearU64.encode(Number(src), b, offset);
    }
    new DataView(b.buffer, b.byteOffset + offset, 8).setBigUint64(0, src, true);
    return 8;
  }
}

export const publicKeyLayout = (property: string): PublicKeyLayout =>
  new PublicKeyLayout(property);

export const u64Layout = (property: string): U64Layout =>
  new U64Layout(property);

// ============================================================================
// SKEMA BINER INSTRUKSI & AKUN ON-CHAIN (TOKEN-2022 + VIRTUAL AMM)
// ============================================================================

export interface RawPoolStateLayoutData {
  discriminator: Uint8Array;
  tokenX: PublicKey;
  tokenY: PublicKey;
  vaultX: PublicKey;
  vaultY: PublicKey;
  lpMint: PublicKey;
  virtualReservesX: bigint;
  virtualReservesY: bigint;
  bump: number;
}

/**
 * Skema biner 185-byte yang cocok 1:1 dengan struct `PoolState` di program Anchor.
 */
export const PoolStateLayout = BufferLayout.struct<RawPoolStateLayoutData>([
  BufferLayout.blob(8, 'discriminator'),
  publicKeyLayout('tokenX'),
  publicKeyLayout('tokenY'),
  publicKeyLayout('vaultX'),
  publicKeyLayout('vaultY'),
  publicKeyLayout('lpMint'),
  u64Layout('virtualReservesX'),
  u64Layout('virtualReservesY'),
  BufferLayout.u8('bump'),
]);

export const POOL_STATE_LAYOUT = PoolStateLayout;

/**
 * `initialize_pool` (disc=0): 1B discriminator + 8B initial_real_token_y + 8B real_sol_deposited = 17B
 */
export const CREATE_POOL_IX_LAYOUT = BufferLayout.struct<{
  discriminator: number;
  initialRealTokenY: bigint;
  realSolDeposited: bigint;
}>([
  BufferLayout.u8('discriminator'),
  u64Layout('initialRealTokenY'),
  u64Layout('realSolDeposited'),
]);

/**
 * `add_liquidity` (disc=1): 1B discriminator + 8B amount_x + 8B amount_y + 8B min_lp_out = 25B
 */
export const ADD_LIQUIDITY_IX_LAYOUT = BufferLayout.struct<{
  discriminator: number;
  amountX: bigint;
  amountY: bigint;
  minLpOut: bigint;
}>([
  BufferLayout.u8('discriminator'),
  u64Layout('amountX'),
  u64Layout('amountY'),
  u64Layout('minLpOut'),
]);

/**
 * `swap` (disc=2): 1B discriminator + 8B amount_in + 8B min_amount_out + 1B x_to_y = 18B
 */
export const SWAP_IX_LAYOUT = BufferLayout.struct<{
  discriminator: number;
  amountIn: bigint;
  minAmountOut: bigint;
  xToY: number;
}>([
  BufferLayout.u8('discriminator'),
  u64Layout('amountIn'),
  u64Layout('minAmountOut'),
  BufferLayout.u8('xToY'),
]);


/**
 * Token-2022 `MetadataPointerInstruction::Initialize` (66 bytes):
 * `[u8(39), u8(0), Pubkey(authority), Pubkey(metadataAddress)]`
 */
export const METADATA_POINTER_INIT_LAYOUT = BufferLayout.struct<{
  extension: number;
  instruction: number;
  authority: PublicKey;
  metadataAddress: PublicKey;
}>([
  BufferLayout.u8('extension'),
  BufferLayout.u8('instruction'),
  publicKeyLayout('authority'),
  publicKeyLayout('metadataAddress'),
]);

/**
 * SPL / Token-2022 `InitializeMint` / `InitializeMint2` (67 bytes)
 */
export const SPL_INITIALIZE_MINT_LAYOUT = BufferLayout.struct<{
  instruction: number;
  decimals: number;
  mintAuthority: PublicKey;
  freezeAuthorityOption: number;
  freezeAuthority: PublicKey;
}>([
  BufferLayout.u8('instruction'),
  BufferLayout.u8('decimals'),
  publicKeyLayout('mintAuthority'),
  BufferLayout.u8('freezeAuthorityOption'),
  publicKeyLayout('freezeAuthority'),
]);

/**
 * SPL / Token-2022 `MintToChecked` (10 bytes): `[u8(14), u64(amount), u8(decimals)]`
 */
export const SPL_MINT_TO_CHECKED_LAYOUT = BufferLayout.struct<{
  instruction: number;
  amount: bigint;
  decimals: number;
}>([
  BufferLayout.u8('instruction'),
  u64Layout('amount'),
  BufferLayout.u8('decimals'),
]);

const SINGLE_U8_IX_LAYOUT = BufferLayout.struct<{ instruction: number }>([
  BufferLayout.u8('instruction'),
]);

const METADATA_V3_TAIL_LAYOUT = BufferLayout.struct<{
  sellerFeeBasisPoints: number;
  creatorsOption: number;
  collectionOption: number;
  usesOption: number;
  isMutable: number;
  collectionDetailsOption: number;
}>([
  BufferLayout.u16('sellerFeeBasisPoints'),
  BufferLayout.u8('creatorsOption'),
  BufferLayout.u8('collectionOption'),
  BufferLayout.u8('usesOption'),
  BufferLayout.u8('isMutable'),
  BufferLayout.u8('collectionDetailsOption'),
]);

/**
 * Base 82-byte Mint header (identik di offset 0..82 baik pada SPL Token maupun Token-2022).
 */
export const SPL_MINT_ACCOUNT_LAYOUT = BufferLayout.struct<{
  mintAuthorityOption: number;
  mintAuthority: PublicKey;
  supply: bigint;
  decimals: number;
  isInitialized: number;
  freezeAuthorityOption: number;
  freezeAuthority: PublicKey;
}>([
  BufferLayout.u32('mintAuthorityOption'),
  publicKeyLayout('mintAuthority'),
  u64Layout('supply'),
  BufferLayout.u8('decimals'),
  BufferLayout.u8('isInitialized'),
  BufferLayout.u32('freezeAuthorityOption'),
  publicKeyLayout('freezeAuthority'),
]);

/**
 * Base 165-byte TokenAccount header (identik di offset 0..165 baik pada SPL Token maupun Token-2022).
 */
export const SPL_TOKEN_ACCOUNT_LAYOUT = BufferLayout.struct<{
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegateOption: number;
  delegate: PublicKey;
  state: number;
  isNativeOption: number;
  isNative: bigint;
  delegatedAmount: bigint;
  closeAuthorityOption: number;
  closeAuthority: PublicKey;
}>([
  publicKeyLayout('mint'),
  publicKeyLayout('owner'),
  u64Layout('amount'),
  BufferLayout.u32('delegateOption'),
  publicKeyLayout('delegate'),
  BufferLayout.u8('state'),
  BufferLayout.u32('isNativeOption'),
  u64Layout('isNative'),
  u64Layout('delegatedAmount'),
  BufferLayout.u32('closeAuthorityOption'),
  publicKeyLayout('closeAuthority'),
]);

// ============================================================================
// PUBLIC INTERFACES
// ============================================================================

export type TokenStandardMode = 'TOKEN_2022' | 'SPL_LEGACY';

export interface OffchainTokenMetadataJson {
  name: string;
  symbol: string;
  description: string;
  image: string;
  extensions: {
    telegram?: string;
    twitter?: string;
  };
}

export interface CloneTokenParams {
  payer: PublicKey;
  mintKeypair?: Keypair;
  name: string;
  symbol: string;
  imageUri: string;
  /**
   * URI JSON metadata (mis. hasil `npm run pinata:upload` -> `metadataUri`).
   * Jika diisi, `uri` on-chain memakai nilai ini, sedangkan `imageUri` tetap
   * dipakai sebagai `image` di dalam JSON tersebut (praktik standar Solana).
   */
  metadataUri?: string;
  telegram?: string;
  twitter?: string;
  decimals?: number;
  initialSupplyRaw: bigint;
  /** Default: `'TOKEN_2022'` (menggunakan Native MetadataPointer + TokenMetadata Extensions) */
  tokenStandard?: TokenStandardMode;
  freezeAuthority?: PublicKey | null;
}

export interface CloneTokenBuildResult {
  mintKeypair: Keypair;
  mint: PublicKey;
  tokenProgramId: PublicKey;
  tokenStandard: TokenStandardMode;
  /** Pada Token-2022, alamat metadata adalah akun `mint` itu sendiri (self-referential MetadataPointer) */
  metadataAddress: PublicKey;
  userTokenAta: PublicKey;
  resolvedMetadataUri: string;
  additionalMetadata: [string, string][];
  offchainMetadataJson: OffchainTokenMetadataJson;
  allocatedMintBytes: number;
  instructions: TransactionInstruction[];
}

export interface DerivedPoolAddresses {
  poolState: PublicKey;
  poolBump: number;
  lpMint: PublicKey;
  lpMintBump: number;
  vaultX: PublicKey;
  vaultXBump: number;
  vaultY: PublicKey;
  vaultYBump: number;
}

export interface CreatePoolParams {
  payer: PublicKey;
  /** Mint Token X (default: `NATIVE_SOL_MINT` / WSOL) */
  tokenX?: PublicKey;
  /** Mint Token Y (Token Proyek Baru — Token-2022 atau SPL) */
  tokenY: PublicKey;
  /** Pasokan Token Y fisik awal yang disetor ke `vault_y` (9 desimal) */
  initialRealTokenY: bigint | number;
  /** Deposit fisik Token X awal (lamports untuk WSOL); virtual reserve X ditetapkan 10x deposit ini. */
  realSolDeposited: bigint | number;
  /** Program ID untuk Token X (default: `TOKEN_PROGRAM_ID` untuk WSOL) */
  tokenProgramX?: PublicKey;
  /** Program ID untuk Token Y (default: `TOKEN_2022_PROGRAM_ID`) */
  tokenProgramY?: PublicKey;
  /** Program ID untuk LP Mint (default: `TOKEN_2022_PROGRAM_ID`) */
  tokenProgramLp?: PublicKey;
  recentBlockhash?: string;
}

export interface CreatePoolBuildResult {
  transaction: Transaction;
  instruction: TransactionInstruction;
  serializedIxData: Buffer;
  addresses: DerivedPoolAddresses;
  userTokenX: PublicKey;
  userTokenY: PublicKey;
  userLpToken: PublicKey;
  expectedInitialLp: bigint;
}

export interface AddLiquidityParams {
  user: PublicKey;
  tokenX?: PublicKey;
  tokenY: PublicKey;
  amountX: bigint | number;
  amountY: bigint | number;
  minLpOut?: bigint | number;
  tokenProgramX?: PublicKey;
  tokenProgramY?: PublicKey;
  tokenProgramLp?: PublicKey;
  recentBlockhash?: string;
}

export interface AddLiquidityBuildResult {
  transaction: Transaction;
  instruction: TransactionInstruction;
  serializedIxData: Buffer;
  addresses: DerivedPoolAddresses;
}

export interface SwapParams {
  user: PublicKey;
  tokenX?: PublicKey;
  tokenY: PublicKey;
  amountIn: bigint | number;
  minAmountOut?: bigint | number;
  /** `true` = Beli Token Y memakai Token X (SOL -> Token-2022), `false` = Jual Token Y ke SOL */
  xToY: boolean;
  tokenProgramX?: PublicKey;
  tokenProgramY?: PublicKey;
  /**
   * Hanya untuk swap Y -> X ketika Token X adalah WSOL. Default `true`: ATA WSOL ditutup
   * (`CloseAccount`) setelah swap sehingga pengguna menerima **SOL native**, bukan WSOL.
   */
  unwrapWsol?: boolean;
  recentBlockhash?: string;
}

export interface SwapBuildResult {
  transaction: Transaction;
  instruction: TransactionInstruction;
  serializedIxData: Buffer;
  addresses: DerivedPoolAddresses;
  /** `true` bila transaksi diakhiri `CloseAccount` untuk mencairkan WSOL menjadi SOL native */
  unwrapWsol: boolean;
}

export interface DeserializedPoolInfo {
  poolAddress: PublicKey;
  discriminator: number[];
  tokenX: PublicKey;
  tokenY: PublicKey;
  vaultX: PublicKey;
  vaultY: PublicKey;
  lpMint: PublicKey;
  tokenProgramX: PublicKey;
  tokenProgramY: PublicKey;
  tokenProgramLp: PublicKey;
  realReservesX: bigint;
  realReservesY: bigint;
  virtualReservesX: bigint;
  virtualReservesY: bigint;
  totalReservesX: bigint;
  totalReservesY: bigint;
  lpSupply: bigint;
  bump: number;
  kEffectiveInvariant: bigint;
  spotPriceXPerY: number;
  rawDataHex: string;
}

// ============================================================================
// MATEMATIKA AMM & HELPER PRESISI BIGINT (9 DESIMAL)
// ============================================================================

export function toU64BigInt(value: bigint | number): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > MAX_U64) {
      throw new RangeError(`Value out of u64 range: ${value.toString()}`);
    }
    return value;
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`Numeric u64 input must be a non-negative integer: ${value}`);
  }
  if (value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `Number ${value} exceeds Number.MAX_SAFE_INTEGER; gunakan BigInt untuk presisi 9 desimal`
    );
  }
  return BigInt(value);
}

export function parseTokenAmount(
  amount: string | number | bigint,
  decimals = DEFAULT_TOKEN_DECIMALS
): bigint {
  if (typeof amount === 'bigint') {
    if (amount < 0n) {
      throw new RangeError(`Nilai token tidak boleh negatif: ${amount.toString()}`);
    }
    const raw = amount * 10n ** BigInt(decimals);
    if (raw > MAX_U64) {
      throw new RangeError(`Nilai raw (${raw.toString()}) melebihi batas u64 Solana`);
    }
    return raw;
  }
  const normalized = String(amount).trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Format angka token tidak valid: "${String(amount)}"`);
  }
  const [wholePart, fracPart = ''] = normalized.split('.');
  if (fracPart.length > decimals) {
    throw new Error(
      `Presisi desimal (${fracPart.length}) melebihi batas desimal token (${decimals})`
    );
  }
  const paddedFrac = fracPart.padEnd(decimals, '0');
  const raw =
    BigInt(wholePart) * 10n ** BigInt(decimals) +
    (paddedFrac.length > 0 ? BigInt(paddedFrac) : 0n);
  if (raw > MAX_U64) {
    throw new RangeError(`Nilai raw (${raw.toString()}) melebihi batas u64 Solana`);
  }
  return raw;
}

export function formatTokenAmount(
  rawAmount: bigint,
  decimals = DEFAULT_TOKEN_DECIMALS,
  maxFractionDigits = 6
): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;
  const fraction = rawAmount % divisor;
  if (fraction === 0n || maxFractionDigits <= 0) {
    return whole.toLocaleString('en-US');
  }
  const fracStr = fraction
    .toString()
    .padStart(decimals, '0')
    .slice(0, maxFractionDigits)
    .replace(/0+$/, '');
  return fracStr.length > 0
    ? `${whole.toLocaleString('en-US')}.${fracStr}`
    : whole.toLocaleString('en-US');
}

export function integerSqrtBigInt(n: bigint): bigint {
  if (n < 0n) {
    throw new RangeError('Cannot compute square root of negative BigInt');
  }
  if (n < 2n) {
    return n;
  }
  let x0 = 1n << BigInt((n.toString(2).length + 1) >> 1);
  let x1 = (x0 + n / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + n / x0) >> 1n;
  }
  return x0;
}

export function calculateInitialLpTokens(amountX: bigint, amountY: bigint): bigint {
  if (amountX <= 0n || amountY <= 0n) {
    throw new Error('Initial liquidity amounts must both be greater than zero');
  }
  const lp = integerSqrtBigInt(amountX * amountY);
  if (lp <= 0n || lp > MAX_U64) {
    throw new RangeError('Computed initial LP tokens out of u64 bounds');
  }
  return lp;
}

/**
 * Constant Product (`x * y = k`) dengan fee 0.30% (997 / 1000) — identik dengan `src/lib.rs`.
 */
export function calculateSwapOutput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): bigint {
  if (amountIn <= 0n) throw new Error('Swap input amount must be strictly positive');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new Error('Pool reserves must be strictly positive');
  const amountInAfterFee = amountIn * (FEE_DENOMINATOR - FEE_NUMERATOR);
  const out = (amountInAfterFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInAfterFee);
  if (out <= 0n) throw new Error('Computed swap output amount is zero');
  if (out >= reserveOut) throw new Error('Computed swap output exhausts the output reserve');
  if (out > MAX_U64) throw new RangeError('Swap output exceeds u64 bounds');
  return out;
}

/**
 * Encode Borsh String (`u32 LE byteLength + utf8Bytes`) menggunakan `@solana/buffer-layout`.
 */
function encodeBorshString(
  value: string,
  maxByteLen = 512,
  fieldName = 'String'
): Buffer {
  const utf8Bytes = Buffer.from(value, 'utf8');
  if (utf8Bytes.length > maxByteLen) {
    throw new Error(
      `${fieldName} (${utf8Bytes.length}B) melebihi batas maksimum (${maxByteLen}B)`
    );
  }
  const layout = BufferLayout.struct<{ len: number; bytes: Uint8Array }>([
    BufferLayout.u32('len'),
    BufferLayout.blob(utf8Bytes.length, 'bytes'),
  ]);
  const buf = Buffer.alloc(layout.span);
  layout.encode({ len: utf8Bytes.length, bytes: utf8Bytes }, buf);
  return buf;
}

/**
 * Menghitung ukuran akhir akun Mint Token-2022 setelah ekstensi `MetadataPointer` + `TokenMetadata`
 * (termasuk pasangan `additional_metadata` seperti Telegram & Twitter) dialokasikan, sehingga
 * `SystemProgram.createAccount` mendanai sewa bebas-rent yang cukup sejak awal transaksi.
 */
export function calculateToken2022MintTotalBytes(params: {
  name: string;
  symbol: string;
  uri: string;
  additionalMetadata: [string, string][];
}): number {
  const baseTlvPayload =
    32 + // update_authority (OptionalNonZeroPubkey)
    32 + // mint (Pubkey)
    (4 + Buffer.byteLength(params.name, 'utf8')) +
    (4 + Buffer.byteLength(params.symbol, 'utf8')) +
    (4 + Buffer.byteLength(params.uri, 'utf8')) +
    4; // Vec<(String, String)> length prefix

  const extraFieldsBytes = params.additionalMetadata.reduce(
    (sum, [k, v]) =>
      sum + 4 + Buffer.byteLength(k, 'utf8') + 4 + Buffer.byteLength(v, 'utf8'),
    0
  );

  // 234B (Mint + MetadataPointer) + 4B (TokenMetadata TLV type+len) + payload
  return TOKEN_2022_MINT_METADATA_POINTER_SIZE + 4 + baseTlvPayload + extraFieldsBytes;
}

// ============================================================================
// CUSTOM DEFI SDK CLASS (TOKEN INTERFACE + LEVERAGED VIRTUAL RESERVES)
// ============================================================================

export class CustomDefiSDK {
  public readonly connection: Connection;
  public readonly programId: PublicKey;

  constructor(connection: Connection, programId: PublicKey = DEFAULT_AMM_PROGRAM_ID) {
    this.connection = connection;
    this.programId = programId;
  }

  // --------------------------------------------------------------------------
  // Deterministic PDA Derivations (Mendukung TOKEN_2022 & TOKEN_PROGRAM_ID)
  // --------------------------------------------------------------------------

  public deriveAssociatedTokenAddress(
    owner: PublicKey,
    mint: PublicKey,
    tokenProgramId: PublicKey = TOKEN_2022_PROGRAM_ID
  ): PublicKey {
    const [ata] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return ata;
  }

  public deriveLegacyMetadataPda(mint: PublicKey): PublicKey {
    const [metadataPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('metadata', 'utf8'),
        METADATA_PROGRAM_ID.toBuffer(),
        mint.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    );
    return metadataPda;
  }

  public derivePoolAddresses(
    tokenX: PublicKey,
    tokenY: PublicKey
  ): DerivedPoolAddresses {
    if (tokenX.equals(tokenY)) {
      throw new Error('Token X dan Token Y mints harus berbeda');
    }

    const [poolState, poolBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('amm_pool', 'utf8'), tokenX.toBuffer(), tokenY.toBuffer()],
      this.programId
    );
    const [lpMint, lpMintBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('lp_mint', 'utf8'), poolState.toBuffer()],
      this.programId
    );
    const [vaultX, vaultXBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_x', 'utf8'), poolState.toBuffer()],
      this.programId
    );
    const [vaultY, vaultYBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_y', 'utf8'), poolState.toBuffer()],
      this.programId
    );

    return {
      poolState,
      poolBump,
      lpMint,
      lpMintBump,
      vaultX,
      vaultXBump,
      vaultY,
      vaultYBump,
    };
  }

  // --------------------------------------------------------------------------
  // Raw Token-2022 & SPL Instruction Builders
  // --------------------------------------------------------------------------

  /**
   * Token-2022 `MetadataPointerInstruction::Initialize` (Wrapper 39, Sub-ix 0, 66 bytes).
   * Wajib dipanggil SEBELUM `InitializeMint2` pada akun Mint Token-2022.
   */
  public buildInitializeMetadataPointerInstruction(
    mint: PublicKey,
    updateAuthority: PublicKey,
    metadataAddress: PublicKey = mint
  ): TransactionInstruction {
    const data = Buffer.alloc(METADATA_POINTER_INIT_LAYOUT.span);
    METADATA_POINTER_INIT_LAYOUT.encode(
      {
        extension: SPL_TOKEN_IX.METADATA_POINTER_EXTENSION, // 39
        instruction: 0, // Initialize
        authority: updateAuthority,
        metadataAddress,
      },
      data
    );

    return new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
      data,
    });
  }

  /**
   * `InitializeMint2` (ix 20, 67 bytes) untuk Token-2022 maupun SPL Legacy.
   */
  public buildInitializeMint2Instruction(
    mint: PublicKey,
    decimals: number,
    mintAuthority: PublicKey,
    freezeAuthority: PublicKey | null = null,
    tokenProgramId: PublicKey = TOKEN_2022_PROGRAM_ID
  ): TransactionInstruction {
    const data = Buffer.alloc(SPL_INITIALIZE_MINT_LAYOUT.span);
    SPL_INITIALIZE_MINT_LAYOUT.encode(
      {
        instruction: SPL_TOKEN_IX.INITIALIZE_MINT2,
        decimals,
        mintAuthority,
        freezeAuthorityOption: freezeAuthority ? 1 : 0,
        freezeAuthority: freezeAuthority ?? PublicKey.default,
      },
      data
    );

    return new TransactionInstruction({
      programId: tokenProgramId,
      keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
      data,
    });
  }

  /**
   * Native Token-2022 `spl_token_metadata_interface::instruction::initialize`
   * Menyimpan `name`, `symbol`, dan `uri` langsung di dalam akun Mint Token-2022.
   */
  public buildInitializeToken2022MetadataInstruction(params: {
    mint: PublicKey;
    updateAuthority: PublicKey;
    mintAuthority: PublicKey;
    name: string;
    symbol: string;
    uri: string;
  }): TransactionInstruction {
    const data = Buffer.concat([
      Buffer.from(TOKEN_METADATA_INITIALIZE_DISCRIMINATOR),
      encodeBorshString(params.name.trim(), 64, 'Token Name'),
      encodeBorshString(params.symbol.trim().toUpperCase(), 16, 'Token Symbol'),
      encodeBorshString(params.uri.trim(), 256, 'Token URI'),
    ]);

    const keys: AccountMeta[] = [
      { pubkey: params.mint, isSigner: false, isWritable: true }, // metadata (self)
      { pubkey: params.updateAuthority, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.mintAuthority, isSigner: true, isWritable: false },
    ];

    return new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys,
      data,
    });
  }

  /**
   * Native Token-2022 `spl_token_metadata_interface::instruction::update_field`
   * Menyimpan pasangan key-value kustom (`telegram`, `twitter`, dll.) on-chain di dalam Mint!
   */
  public buildUpdateToken2022MetadataFieldInstruction(params: {
    mint: PublicKey;
    updateAuthority: PublicKey;
    key: string;
    value: string;
  }): TransactionInstruction {
    // Enum `Field::Key(String)` adalah variant ke-3 (`u8 = 3`) diikuti Borsh String `key` & `value`
    const fieldTag = Buffer.alloc(1);
    SINGLE_U8_IX_LAYOUT.encode({ instruction: 3 }, fieldTag);

    const data = Buffer.concat([
      Buffer.from(TOKEN_METADATA_UPDATE_FIELD_DISCRIMINATOR),
      fieldTag,
      encodeBorshString(params.key.trim(), 64, 'Metadata Field Key'),
      encodeBorshString(params.value.trim(), 256, 'Metadata Field Value'),
    ]);

    const keys: AccountMeta[] = [
      { pubkey: params.mint, isSigner: false, isWritable: true },
      { pubkey: params.updateAuthority, isSigner: true, isWritable: false },
    ];

    return new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys,
      data,
    });
  }

  public buildCreateAssociatedTokenIdempotentInstruction(
    payer: PublicKey,
    associatedToken: PublicKey,
    owner: PublicKey,
    mint: PublicKey,
    tokenProgramId: PublicKey = TOKEN_2022_PROGRAM_ID
  ): TransactionInstruction {
    const data = Buffer.alloc(SINGLE_U8_IX_LAYOUT.span);
    SINGLE_U8_IX_LAYOUT.encode({ instruction: 1 }, data);

    return new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: associatedToken, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  /**
   * `MintToChecked` (ix 14, 10 bytes) — standar aman untuk Token-2022 & SPL Token.
   */
  public buildMintToCheckedInstruction(
    mint: PublicKey,
    destinationAta: PublicKey,
    mintAuthority: PublicKey,
    amount: bigint,
    decimals: number,
    tokenProgramId: PublicKey = TOKEN_2022_PROGRAM_ID
  ): TransactionInstruction {
    const data = Buffer.alloc(SPL_MINT_TO_CHECKED_LAYOUT.span);
    SPL_MINT_TO_CHECKED_LAYOUT.encode(
      {
        instruction: SPL_TOKEN_IX.MINT_TO_CHECKED,
        amount,
        decimals,
      },
      data
    );

    return new TransactionInstruction({
      programId: tokenProgramId,
      // `MintToChecked` = 3 akun: [mint (w), destination (w), mint_authority (s)].
      // JANGAN menyisipkan `mint` kedua di indeks 1 — itu layout `TransferChecked`
      // ([source, mint, destination, authority]). Dengan mint ganda, Token-2022 membaca
      // akun Mint (bukan ATA) sebagai `destination`; datanya lalu di-unpack sebagai akun
      // token dan gagal dengan `Error: UninitializedAccount`
      // ("instruction requires an initialized account").
      keys: [
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: destinationAta, isSigner: false, isWritable: true },
        { pubkey: mintAuthority, isSigner: true, isWritable: false },
      ],
      data,
    });
  }

  public buildSyncNativeInstruction(
    wsolAta: PublicKey,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): TransactionInstruction {
    const data = Buffer.alloc(SINGLE_U8_IX_LAYOUT.span);
    SINGLE_U8_IX_LAYOUT.encode({ instruction: SPL_TOKEN_IX.SYNC_NATIVE }, data);

    return new TransactionInstruction({
      programId: tokenProgramId,
      keys: [{ pubkey: wsolAta, isSigner: false, isWritable: true }],
      data,
    });
  }

  /**
   * SPL Token / Token-2022 `CloseAccount` (ix 9, 1 byte).
   * Dipakai untuk mencairkan seluruh saldo WSOL di ATA menjadi SOL native di `destination`.
   */
  public buildCloseAccountInstruction(
    account: PublicKey,
    destination: PublicKey,
    owner: PublicKey,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): TransactionInstruction {
    const data = Buffer.alloc(SINGLE_U8_IX_LAYOUT.span);
    SINGLE_U8_IX_LAYOUT.encode({ instruction: SPL_TOKEN_IX.CLOSE_ACCOUNT }, data);

    return new TransactionInstruction({
      programId: tokenProgramId,
      keys: [
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data,
    });
  }

  public buildLegacyMetaplexMetadataV3Instruction(params: {
    metadataPda: PublicKey;
    mint: PublicKey;
    mintAuthority: PublicKey;
    payer: PublicKey;
    updateAuthority: PublicKey;
    name: string;
    symbol: string;
    uri: string;
  }): TransactionInstruction {
    const discriminatorBuf = Buffer.alloc(1);
    SINGLE_U8_IX_LAYOUT.encode(
      { instruction: METAPLEX_CREATE_METADATA_V3_IX },
      discriminatorBuf
    );
    const tailBuf = Buffer.alloc(METADATA_V3_TAIL_LAYOUT.span);
    METADATA_V3_TAIL_LAYOUT.encode(
      {
        sellerFeeBasisPoints: 0,
        creatorsOption: 0,
        collectionOption: 0,
        usesOption: 0,
        isMutable: 1,
        collectionDetailsOption: 0,
      },
      tailBuf
    );

    const data = Buffer.concat([
      discriminatorBuf,
      encodeBorshString(params.name.trim(), 32, 'Token Name'),
      encodeBorshString(params.symbol.trim().toUpperCase(), 10, 'Token Symbol'),
      encodeBorshString(params.uri.trim(), 200, 'Metadata URI'),
      tailBuf,
    ]);

    return new TransactionInstruction({
      programId: METADATA_PROGRAM_ID,
      keys: [
        { pubkey: params.metadataPda, isSigner: false, isWritable: true },
        { pubkey: params.mint, isSigner: false, isWritable: false },
        { pubkey: params.mintAuthority, isSigner: true, isWritable: false },
        { pubkey: params.payer, isSigner: true, isWritable: true },
        { pubkey: params.updateAuthority, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  // --------------------------------------------------------------------------
  // 1. CLONE TOKEN PIPELINE (`buildCloneTokenInstructions` — TOKEN-2022 DEFAULT)
  // --------------------------------------------------------------------------

  /**
   * Membuat Mint Token baru (Default: **Token-2022** dengan ekstensi native `MetadataPointer` +
   * `TokenMetadata` + `UpdateField` on-chain untuk Telegram & Twitter) serta mencetak suplai awal.
   */
  public async buildCloneTokenInstructions(
    params: CloneTokenParams
  ): Promise<CloneTokenBuildResult> {
    const mintKeypair = params.mintKeypair ?? Keypair.generate();
    const mint = mintKeypair.publicKey;
    const decimals = params.decimals ?? DEFAULT_TOKEN_DECIMALS;
    const tokenStandard: TokenStandardMode = params.tokenStandard ?? 'TOKEN_2022';
    const tokenProgramId =
      tokenStandard === 'TOKEN_2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    const cleanName = params.name.trim();
    const cleanSymbol = params.symbol.trim().toUpperCase();
    const cleanImage = params.imageUri.trim();
    const cleanMetadataUri = params.metadataUri?.trim();
    // `uri` on-chain: JSON metadata bila tersedia, jika tidak jatuh ke URL gambar.
    const onchainUri =
      cleanMetadataUri && cleanMetadataUri.length > 0 ? cleanMetadataUri : cleanImage;
    const cleanTelegram = params.telegram?.trim();
    const cleanTwitter = params.twitter?.trim();

    const additionalMetadata: [string, string][] = [];
    if (cleanTelegram) additionalMetadata.push(['telegram', cleanTelegram]);
    if (cleanTwitter) additionalMetadata.push(['twitter', cleanTwitter]);

    const offchainMetadataJson: OffchainTokenMetadataJson = {
      name: cleanName,
      symbol: cleanSymbol,
      description: `${cleanName} ($${cleanSymbol}) — Token-2022 Leveraged Virtual-Reserve AMM Launchpad`,
      image: cleanImage,
      extensions: {
        ...(cleanTelegram ? { telegram: cleanTelegram } : {}),
        ...(cleanTwitter ? { twitter: cleanTwitter } : {}),
      },
    };

    const userTokenAta = this.deriveAssociatedTokenAddress(
      params.payer,
      mint,
      tokenProgramId
    );
    const instructions: TransactionInstruction[] = [];

    if (tokenStandard === 'TOKEN_2022') {
      // Hitung ukuran penuh akhir (234B + TLV TokenMetadata + Telegram/Twitter fields) untuk sewa lamports
      const finalMintBytes = calculateToken2022MintTotalBytes({
        name: cleanName,
        symbol: cleanSymbol,
        uri: onchainUri,
        additionalMetadata,
      });
      const rentLamports =
        await this.connection.getMinimumBalanceForRentExemption(finalMintBytes);

      // 1. Alokasi akun Mint 234-byte (ruang awal untuk Base Mint + MetadataPointer),
      //    didanai penuh dengan `rentLamports` untuk menampung realloc TokenMetadata
      instructions.push(
        SystemProgram.createAccount({
          fromPubkey: params.payer,
          newAccountPubkey: mint,
          space: TOKEN_2022_MINT_METADATA_POINTER_SIZE,
          lamports: rentLamports,
          programId: TOKEN_2022_PROGRAM_ID,
        })
      );

      // 2. Inisialisasi ekstensi MetadataPointer menunjuk ke akun Mint itu sendiri
      instructions.push(
        this.buildInitializeMetadataPointerInstruction(mint, params.payer, mint)
      );

      // 3. Inisialisasi Mint Token-2022 (`InitializeMint2`)
      instructions.push(
        this.buildInitializeMint2Instruction(
          mint,
          decimals,
          params.payer,
          params.freezeAuthority ?? null,
          TOKEN_2022_PROGRAM_ID
        )
      );

      // 4. Inisialisasi Native On-Chain TokenMetadata (name, symbol, uri)
      instructions.push(
        this.buildInitializeToken2022MetadataInstruction({
          mint,
          updateAuthority: params.payer,
          mintAuthority: params.payer,
          name: cleanName,
          symbol: cleanSymbol,
          uri: onchainUri,
        })
      );

      // 5. Simpan link sosial (Telegram & Twitter) secara NATIVE ON-CHAIN di dalam Mint Token-2022!
      for (const [key, value] of additionalMetadata) {
        instructions.push(
          this.buildUpdateToken2022MetadataFieldInstruction({
            mint,
            updateAuthority: params.payer,
            key,
            value,
          })
        );
      }

      // 6. Buat ATA Token-2022 & cetak pasokan awal (`MintToChecked`)
      if (params.initialSupplyRaw > 0n) {
        instructions.push(
          this.buildCreateAssociatedTokenIdempotentInstruction(
            params.payer,
            userTokenAta,
            params.payer,
            mint,
            TOKEN_2022_PROGRAM_ID
          ),
          this.buildMintToCheckedInstruction(
            mint,
            userTokenAta,
            params.payer,
            params.initialSupplyRaw,
            decimals,
            TOKEN_2022_PROGRAM_ID
          )
        );
      }

      return {
        mintKeypair,
        mint,
        tokenProgramId,
        tokenStandard,
        metadataAddress: mint,
        userTokenAta,
        resolvedMetadataUri: onchainUri,
        additionalMetadata,
        offchainMetadataJson,
        allocatedMintBytes: finalMintBytes,
        instructions,
      };
    }

    // Mode kompatibilitas SPL Legacy + Metaplex V3
    const legacyRent =
      await this.connection.getMinimumBalanceForRentExemption(SPL_MINT_SIZE);
    const metadataPda = this.deriveLegacyMetadataPda(mint);

    instructions.push(
      SystemProgram.createAccount({
        fromPubkey: params.payer,
        newAccountPubkey: mint,
        space: SPL_MINT_SIZE,
        lamports: legacyRent,
        programId: TOKEN_PROGRAM_ID,
      }),
      this.buildInitializeMint2Instruction(
        mint,
        decimals,
        params.payer,
        params.freezeAuthority ?? null,
        TOKEN_PROGRAM_ID
      ),
      this.buildLegacyMetaplexMetadataV3Instruction({
        metadataPda,
        mint,
        mintAuthority: params.payer,
        payer: params.payer,
        updateAuthority: params.payer,
        name: cleanName,
        symbol: cleanSymbol,
        uri: onchainUri.slice(0, 200),
      })
    );

    if (params.initialSupplyRaw > 0n) {
      instructions.push(
        this.buildCreateAssociatedTokenIdempotentInstruction(
          params.payer,
          userTokenAta,
          params.payer,
          mint,
          TOKEN_PROGRAM_ID
        ),
        this.buildMintToCheckedInstruction(
          mint,
          userTokenAta,
          params.payer,
          params.initialSupplyRaw,
          decimals,
          TOKEN_PROGRAM_ID
        )
      );
    }

    return {
      mintKeypair,
      mint,
      tokenProgramId,
      tokenStandard,
      metadataAddress: metadataPda,
      userTokenAta,
      resolvedMetadataUri: onchainUri,
      additionalMetadata,
      offchainMetadataJson,
      allocatedMintBytes: SPL_MINT_SIZE,
      instructions,
    };
  }

  // --------------------------------------------------------------------------
  // 2. CREATE LEVERAGED VIRTUAL-RESERVE POOL (`buildCreatePoolTx`)
  // --------------------------------------------------------------------------

  /**
   * Serialisasi `initialize_pool` (`u8` discriminator = 0 + `initialRealTokenY` + `realSolDeposited`)
   * dan menyusun 16 `AccountMeta` lintas-program (`tokenProgramX`, `tokenProgramY`, `tokenProgramLp`).
   *
   * Transaksi yang dihasilkan berisi 2 instruksi:
   * 1. `CreateIdempotent` ATA `userTokenY` — account ini WAJIB sudah ada karena
   *    `InitializePool<'info>` mendeklarasikannya sebagai `token::authority = payer`
   *    (bukan `init_if_needed`), sehingga tanpa instruksi ini `initialize_pool` gagal
   *    dengan `AccountNotInitialized` bila pengguna belum punya ATA token Y.
   * 2. `initialize_pool` (17 byte payload, disc = 0).
   */
  public async buildCreatePoolTx(
    params: CreatePoolParams
  ): Promise<CreatePoolBuildResult> {
    const tokenX = params.tokenX ?? NATIVE_SOL_MINT;
    const tokenY = params.tokenY;
    const initialRealTokenY = toU64BigInt(params.initialRealTokenY);
    const realSolDeposited = toU64BigInt(params.realSolDeposited);
    if (initialRealTokenY <= 0n || realSolDeposited <= 0n) {
      throw new Error('initialRealTokenY dan realSolDeposited harus lebih besar dari 0n');
    }
    const virtualReservesX = realSolDeposited * LEVERAGE_MULTIPLIER;
    if (virtualReservesX > MAX_U64) throw new RangeError('Virtual reserve X melebihi u64');

    const tokenProgramX =
      params.tokenProgramX ??
      (tokenX.equals(NATIVE_SOL_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
    const tokenProgramY = params.tokenProgramY ?? TOKEN_2022_PROGRAM_ID;
    const tokenProgramLp = params.tokenProgramLp ?? TOKEN_2022_PROGRAM_ID;

    const addresses = this.derivePoolAddresses(tokenX, tokenY);
    const userTokenX = this.deriveAssociatedTokenAddress(params.payer, tokenX, tokenProgramX);
    const userTokenY = this.deriveAssociatedTokenAddress(
      params.payer,
      tokenY,
      tokenProgramY
    );
    const userLpToken = this.deriveAssociatedTokenAddress(
      params.payer,
      addresses.lpMint,
      tokenProgramLp
    );

    const serializedIxData = Buffer.alloc(CREATE_POOL_IX_LAYOUT.span);
    CREATE_POOL_IX_LAYOUT.encode(
      {
        discriminator: AMM_IX_DISCRIMINATOR.INITIALIZE_POOL,
        initialRealTokenY,
        realSolDeposited,
      },
      serializedIxData
    );

    // 16 AccountMeta persis sesuai `InitializePool<'info>`; includes both depositor token accounts.
    const keys: AccountMeta[] = [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false },
      { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: addresses.poolState, isSigner: false, isWritable: true },
      { pubkey: addresses.lpMint, isSigner: false, isWritable: true },
      { pubkey: addresses.vaultX, isSigner: false, isWritable: true },
      { pubkey: addresses.vaultY, isSigner: false, isWritable: true },
      { pubkey: userTokenX, isSigner: false, isWritable: true },
      { pubkey: userTokenY, isSigner: false, isWritable: true },
      { pubkey: userLpToken, isSigner: false, isWritable: true },
      { pubkey: tokenProgramX, isSigner: false, isWritable: false },
      { pubkey: tokenProgramY, isSigner: false, isWritable: false },
      { pubkey: tokenProgramLp, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys,
      data: serializedIxData,
    });

    const transaction = new Transaction();
    transaction.add(
      this.buildCreateAssociatedTokenIdempotentInstruction(params.payer, userTokenX, params.payer, tokenX, tokenProgramX),
      this.buildCreateAssociatedTokenIdempotentInstruction(params.payer, userTokenY, params.payer, tokenY, tokenProgramY),
    );
    if (tokenX.equals(NATIVE_SOL_MINT)) {
      transaction.add(SystemProgram.transfer({ fromPubkey: params.payer, toPubkey: userTokenX, lamports: realSolDeposited }), this.buildSyncNativeInstruction(userTokenX, tokenProgramX));
    }
    transaction.add(instruction);
    transaction.feePayer = params.payer;
    transaction.recentBlockhash =
      params.recentBlockhash ??
      (await this.connection.getLatestBlockhash('confirmed')).blockhash;

    // Kurva efektif = `vault.amount + virtual_reserves`; karena `virtual_reserves_y = 0`
    // (lihat `initialize_pool`), suplai LP awal = sqrt(virtualReservesX * initialRealTokenY).
    const expectedInitialLp = calculateInitialLpTokens(
      virtualReservesX,
      initialRealTokenY
    );

    return {
      transaction,
      instruction,
      serializedIxData,
      addresses,
      userTokenX,
      userTokenY,
      userLpToken,
      expectedInitialLp,
    };
  }

  // --------------------------------------------------------------------------
  // 3. ADD LIQUIDITY (`buildAddLiquidityTx`)
  // --------------------------------------------------------------------------

  public async buildAddLiquidityTx(
    params: AddLiquidityParams
  ): Promise<AddLiquidityBuildResult> {
    const tokenX = params.tokenX ?? NATIVE_SOL_MINT;
    const tokenY = params.tokenY;
    const amountX = toU64BigInt(params.amountX);
    const amountY = toU64BigInt(params.amountY);
    const minLpOut = toU64BigInt(params.minLpOut ?? 0n);

    if (amountX <= 0n || amountY <= 0n) {
      throw new Error('amountX dan amountY harus lebih besar dari 0n');
    }

    const tokenProgramX =
      params.tokenProgramX ??
      (tokenX.equals(NATIVE_SOL_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
    const tokenProgramY = params.tokenProgramY ?? TOKEN_2022_PROGRAM_ID;
    const tokenProgramLp = params.tokenProgramLp ?? TOKEN_2022_PROGRAM_ID;

    const addresses = this.derivePoolAddresses(tokenX, tokenY);
    const userTokenX = this.deriveAssociatedTokenAddress(
      params.user,
      tokenX,
      tokenProgramX
    );
    const userTokenY = this.deriveAssociatedTokenAddress(
      params.user,
      tokenY,
      tokenProgramY
    );
    const userLpToken = this.deriveAssociatedTokenAddress(
      params.user,
      addresses.lpMint,
      tokenProgramLp
    );

    const transaction = new Transaction();
    transaction.add(
      this.buildCreateAssociatedTokenIdempotentInstruction(
        params.user,
        userTokenX,
        params.user,
        tokenX,
        tokenProgramX
      ),
      this.buildCreateAssociatedTokenIdempotentInstruction(
        params.user,
        userTokenY,
        params.user,
        tokenY,
        tokenProgramY
      ),
      this.buildCreateAssociatedTokenIdempotentInstruction(
        params.user,
        userLpToken,
        params.user,
        addresses.lpMint,
        tokenProgramLp
      )
    );

    if (tokenX.equals(NATIVE_SOL_MINT)) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: params.user,
          toPubkey: userTokenX,
          lamports: amountX,
        }),
        this.buildSyncNativeInstruction(userTokenX, TOKEN_PROGRAM_ID)
      );
    }

    const serializedIxData = Buffer.alloc(ADD_LIQUIDITY_IX_LAYOUT.span);
    ADD_LIQUIDITY_IX_LAYOUT.encode(
      {
        discriminator: AMM_IX_DISCRIMINATOR.ADD_LIQUIDITY,
        amountX,
        amountY,
        minLpOut,
      },
      serializedIxData
    );

    // 13 AccountMeta sesuai `AddLiquidity<'info>` di `src/lib.rs`
    const keys: AccountMeta[] = [
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false },
      { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: addresses.poolState, isSigner: false, isWritable: false },
      { pubkey: addresses.lpMint, isSigner: false, isWritable: true },
      { pubkey: addresses.vaultX, isSigner: false, isWritable: true },
      { pubkey: addresses.vaultY, isSigner: false, isWritable: true },
      { pubkey: userTokenX, isSigner: false, isWritable: true },
      { pubkey: userTokenY, isSigner: false, isWritable: true },
      { pubkey: userLpToken, isSigner: false, isWritable: true },
      { pubkey: tokenProgramX, isSigner: false, isWritable: false },
      { pubkey: tokenProgramY, isSigner: false, isWritable: false },
      { pubkey: tokenProgramLp, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys,
      data: serializedIxData,
    });

    transaction.add(instruction);
    transaction.feePayer = params.user;
    transaction.recentBlockhash =
      params.recentBlockhash ??
      (await this.connection.getLatestBlockhash('confirmed')).blockhash;

    return {
      transaction,
      instruction,
      serializedIxData,
      addresses,
    };
  }

  // --------------------------------------------------------------------------
  // 4. SWAP (`buildSwapTx` — Token-2022 & Virtual + Real Reserves)
  // --------------------------------------------------------------------------

  public async buildSwapTx(params: SwapParams): Promise<SwapBuildResult> {
    const tokenX = params.tokenX ?? NATIVE_SOL_MINT;
    const tokenY = params.tokenY;
    const amountIn = toU64BigInt(params.amountIn);
    const minAmountOut = toU64BigInt(params.minAmountOut ?? 0n);

    if (amountIn <= 0n) {
      throw new Error('Swap amountIn harus lebih besar dari 0n');
    }

    const tokenProgramX =
      params.tokenProgramX ??
      (tokenX.equals(NATIVE_SOL_MINT) ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID);
    const tokenProgramY = params.tokenProgramY ?? TOKEN_2022_PROGRAM_ID;

    const addresses = this.derivePoolAddresses(tokenX, tokenY);
    const userTokenX = this.deriveAssociatedTokenAddress(
      params.user,
      tokenX,
      tokenProgramX
    );
    const userTokenY = this.deriveAssociatedTokenAddress(
      params.user,
      tokenY,
      tokenProgramY
    );

    const transaction = new Transaction();
    transaction.add(
      this.buildCreateAssociatedTokenIdempotentInstruction(
        params.user,
        userTokenX,
        params.user,
        tokenX,
        tokenProgramX
      ),
      this.buildCreateAssociatedTokenIdempotentInstruction(
        params.user,
        userTokenY,
        params.user,
        tokenY,
        tokenProgramY
      )
    );

    if (params.xToY && tokenX.equals(NATIVE_SOL_MINT)) {
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: params.user,
          toPubkey: userTokenX,
          lamports: amountIn,
        }),
        this.buildSyncNativeInstruction(userTokenX, TOKEN_PROGRAM_ID)
      );
    }

    const serializedIxData = Buffer.alloc(SWAP_IX_LAYOUT.span);
    SWAP_IX_LAYOUT.encode(
      {
        discriminator: AMM_IX_DISCRIMINATOR.SWAP,
        amountIn,
        minAmountOut,
        xToY: params.xToY ? 1 : 0,
      },
      serializedIxData
    );

    // 10 AccountMeta sesuai `Swap<'info>` di `programs/mini-amm/src/lib.rs`.
    const keys: AccountMeta[] = [
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: tokenX, isSigner: false, isWritable: false },
      { pubkey: tokenY, isSigner: false, isWritable: false },
      { pubkey: addresses.poolState, isSigner: false, isWritable: false },
      { pubkey: addresses.vaultX, isSigner: false, isWritable: true },
      { pubkey: addresses.vaultY, isSigner: false, isWritable: true },
      { pubkey: userTokenX, isSigner: false, isWritable: true },
      { pubkey: userTokenY, isSigner: false, isWritable: true },
      { pubkey: tokenProgramX, isSigner: false, isWritable: false },
      { pubkey: tokenProgramY, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
      programId: this.programId,
      keys,
      data: serializedIxData,
    });

    transaction.add(instruction);

    // Jual Token Y -> WSOL: tutup ATA WSOL agar pengguna menerima SOL native (unwrap).
    const unwrapWsol =
      params.unwrapWsol ?? (!params.xToY && tokenX.equals(NATIVE_SOL_MINT));
    if (unwrapWsol) {
      if (params.xToY) {
        throw new Error(
          'unwrapWsol hanya berlaku untuk swap Y -> X (menjual token ke WSOL)'
        );
      }
      if (!tokenX.equals(NATIVE_SOL_MINT)) {
        throw new Error('unwrapWsol hanya berlaku bila Token X adalah WSOL');
      }
      transaction.add(
        this.buildCloseAccountInstruction(
          userTokenX,
          params.user,
          params.user,
          tokenProgramX
        )
      );
    }

    transaction.feePayer = params.user;
    transaction.recentBlockhash =
      params.recentBlockhash ??
      (await this.connection.getLatestBlockhash('confirmed')).blockhash;

    return {
      transaction,
      instruction,
      serializedIxData,
      addresses,
      unwrapWsol,
    };
  }

  // --------------------------------------------------------------------------
  // 5. FETCH & DESERIALIZE POOL INFO (`fetchPoolInfo`)
  // --------------------------------------------------------------------------

  /**
   * Mengambil buffer 185-byte `PoolState` serta membaca saldo vault fisik (`vault_x`, `vault_y`),
   * `lp_mint`, dan
   * dan `lp_mint` (kompatibel penuh baik untuk akun SPL Legacy maupun akun ber-ekstensi Token-2022).
   */
  public async fetchPoolInfo(
    poolOrTokenX: PublicKey,
    maybeTokenY?: PublicKey
  ): Promise<DeserializedPoolInfo> {
    const poolAddress = maybeTokenY
      ? this.derivePoolAddresses(poolOrTokenX, maybeTokenY).poolState
      : poolOrTokenX;

    const accountInfo = await this.connection.getAccountInfo(
      poolAddress,
      'confirmed'
    );
    if (!accountInfo) {
      throw new Error(
        `Akun PoolState tidak ditemukan pada PDA ${poolAddress.toBase58()}`
      );
    }

    if (!accountInfo.owner.equals(this.programId)) {
      throw new Error(
        `Owner PoolState tidak valid: diharapkan ${this.programId.toBase58()}, diterima ${accountInfo.owner.toBase58()}`
      );
    }

    if (accountInfo.data.byteLength < POOL_STATE_SIZE) {
      throw new Error(
        `Buffer PoolState rusak: diharapkan >= ${POOL_STATE_SIZE} bytes, diterima ${accountInfo.data.byteLength}`
      );
    }

    const decoded = PoolStateLayout.decode(
      accountInfo.data.subarray(0, POOL_STATE_SIZE)
    );

    for (let i = 0; i < POOL_STATE_DISCRIMINATOR.length; i++) {
      if (decoded.discriminator[i] !== POOL_STATE_DISCRIMINATOR[i]) {
        throw new Error(
          'Discriminator Anchor 8-byte tidak cocok saat men-decode PoolState'
        );
      }
    }

    let realReservesX = 0n;
    let realReservesY = 0n;
    let lpSupply = 0n;
    let tokenProgramX = TOKEN_PROGRAM_ID;
    let tokenProgramY = TOKEN_2022_PROGRAM_ID;
    let tokenProgramLp = TOKEN_2022_PROGRAM_ID;

    const [vaultXAcc, vaultYAcc, lpMintAcc] = await this.connection.getMultipleAccountsInfo(
      [decoded.vaultX, decoded.vaultY, decoded.lpMint], 'confirmed'
    );

    // Header 165B TokenAccount & 82B Mint sama persis pada SPL Legacy maupun Token-2022!
    if (vaultXAcc && vaultXAcc.data.byteLength >= SPL_TOKEN_ACCOUNT_SIZE) {
      realReservesX = SPL_TOKEN_ACCOUNT_LAYOUT.decode(
        vaultXAcc.data.subarray(0, SPL_TOKEN_ACCOUNT_SIZE)
      ).amount;
      tokenProgramX = vaultXAcc.owner;
    }
    if (vaultYAcc && vaultYAcc.data.byteLength >= SPL_TOKEN_ACCOUNT_SIZE) {
      realReservesY = SPL_TOKEN_ACCOUNT_LAYOUT.decode(
        vaultYAcc.data.subarray(0, SPL_TOKEN_ACCOUNT_SIZE)
      ).amount;
      tokenProgramY = vaultYAcc.owner;
    }
    if (lpMintAcc && lpMintAcc.data.byteLength >= SPL_MINT_SIZE) {
      lpSupply = SPL_MINT_ACCOUNT_LAYOUT.decode(
        lpMintAcc.data.subarray(0, SPL_MINT_SIZE)
      ).supply;
      tokenProgramLp = lpMintAcc.owner;
    }

    const totalReservesX = realReservesX + decoded.virtualReservesX;
    const totalReservesY = realReservesY + decoded.virtualReservesY;
    const kEffectiveInvariant = totalReservesX * totalReservesY;

    const spotPriceXPerY =
      totalReservesY > 0n
        ? Number((totalReservesX * 1_000_000_000_000n) / totalReservesY) /
          1_000_000_000_000
        : 0;

    return {
      poolAddress,
      discriminator: Array.from(decoded.discriminator),
      tokenX: decoded.tokenX,
      tokenY: decoded.tokenY,
      vaultX: decoded.vaultX,
      vaultY: decoded.vaultY,
      lpMint: decoded.lpMint,
      tokenProgramX,
      tokenProgramY,
      tokenProgramLp,
      realReservesX,
      realReservesY,
      virtualReservesX: decoded.virtualReservesX,
      virtualReservesY: decoded.virtualReservesY,
      totalReservesX,
      totalReservesY,
      lpSupply,
      bump: decoded.bump,
      kEffectiveInvariant,
      spotPriceXPerY,
      rawDataHex: Buffer.from(
        accountInfo.data.subarray(0, POOL_STATE_SIZE)
      ).toString('hex'),
    };
  }
}
