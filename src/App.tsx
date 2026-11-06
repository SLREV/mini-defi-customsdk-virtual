import React, { useEffect, useMemo, useState } from 'react';
import {
  AccountInfo,
  Commitment,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  DEFAULT_TOKEN_DECIMALS,
  DeserializedPoolInfo,
  NATIVE_SOL_MINT,
  POOL_STATE_DISCRIMINATOR,
  POOL_STATE_SIZE,
  PoolStateLayout,
  SPL_MINT_ACCOUNT_LAYOUT,
  SPL_MINT_SIZE,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SDK_BUILD_TAG,
  SPL_TOKEN_ACCOUNT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenStandardMode,
  calculateCreatorFee,
  calculateSwapOutput,
  formatTokenAmount,
  parseTokenAmount,
} from './sdk/customSdk';

interface InjectedSolanaProvider {
  isPhantom?: boolean;
  publicKey?: PublicKey;
  connect: () => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}

declare global {
  interface Window {
    solana?: InjectedSolanaProvider;
  }
}

type LaunchStage =
  | 'IDLE'
  | 'MINTING_TOKEN'
  | 'INITIALIZING_POOL'
  | 'INITIAL_SWAP'
  | 'FETCHING_POOL'
  | 'SWAPPING'
  | 'SUCCESS'
  | 'ERROR';

interface PipelineStepLog {
  step: number;
  label: string;
  status: 'pending' | 'active' | 'done' | 'error';
  detail?: string;
}

interface BinaryTelemetry {
  mintAddress: string;
  tokenStandard: TokenStandardMode;
  tokenProgramY: string;
  allocatedMintBytes: number;
  additionalMetadata: [string, string][];
  createPoolIxHex: string;
  lastSwapIxHex?: string;
  cloneIxCount: number;
}

/**
 * Endpoint RPC devnet. Bisa dioverride lewat `.env` (VITE_RPC_ENDPOINT) bila RPC publik
 * kena rate-limit (mis. Helius/QuickNode devnet).
 */
const DEVNET_RPC_ENDPOINT =
  (import.meta.env.VITE_RPC_ENDPOINT as string | undefined)?.trim() ||
  'https://api.devnet.solana.com';

const DEVNET_RPC_HOST = ((): string => {
  try {
    return new URL(DEVNET_RPC_ENDPOINT).host;
  } catch {
    return DEVNET_RPC_ENDPOINT;
  }
})();

/** Batas minimum SOL agar pipeline devnet tidak gagal di tengah jalan. */
const MIN_DEVNET_SOL = 0.05;

/**
 * Compute unit limit eksplisit: transaksi mint Token-2022 mengalokasikan TLV metadata
 * (+ realloc) plus 8 instruksi, sehingga bisa melewati default 200k CU di devnet.
 */
const CLONE_TX_COMPUTE_UNITS = 600_000;
const AMM_TX_COMPUTE_UNITS = 300_000;

const withComputeBudget = (tx: Transaction, units: number): Transaction => {
  const rebuilt = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ...tx.instructions
  );
  rebuilt.feePayer = tx.feePayer;
  rebuilt.recentBlockhash = tx.recentBlockhash;
  return rebuilt;
};

/** Terjemahkan error RPC/preflight menjadi pesan yang bisa ditindaklanjuti. */
const describeRpcError = (err: unknown, rpcEndpoint: string): string => {
  const logs =
    typeof err === 'object' && err !== null && 'logs' in err
      ? ((err as { logs?: string[] | null }).logs ?? null)
      : null;
  const raw = err instanceof Error ? err.message : String(err);
  const haystack = `${raw} ${(logs ?? []).join(' ')}`;

  if (
    /Attempt to load a program that does not exist|InvalidProgramId|UnsupportedProgramId|program that does not exist/i.test(
      haystack
    )
  ) {
    return `Program AMM ${DEFAULT_AMM_PROGRAM_ID.toBase58()} belum ter-deploy di ${rpcEndpoint}. Jalankan "anchor build && anchor deploy --provider.cluster devnet" terlebih dahulu.`;
  }
  if (/insufficient (funds|lamports)|InsufficientFundsForRent|0x1/i.test(haystack)) {
    return `Saldo SOL wallet tidak cukup untuk fee/rent di ${rpcEndpoint}. Di devnet klik "Airdrop 1 SOL" atau pakai faucet.solana.com.`;
  }
  if (/Blockhash not found|block height exceeded|BlockhashNotFound/i.test(haystack)) {
    return 'Blockhash transaksi kedaluwarsa. Coba kirim ulang (pipeline akan mengambil blockhash baru).';
  }
  if (/429|Too Many Requests|rate.?limit|-32429/i.test(haystack)) {
    return `RPC ${rpcEndpoint} menolak karena rate-limit. Set VITE_RPC_ENDPOINT ke RPC devnet lain (Helius/QuickNode) di file .env.`;
  }
  if (/User rejected|rejected the request/i.test(haystack)) {
    return 'Transaksi ditolak di wallet.';
  }
  if (
    /UninitializedAccount|instruction requires an initialized account|AccountNotInitialized/i.test(
      haystack
    )
  ) {
    const failedIx = raw.match(/Error processing Instruction (\d+)/i)?.[1];
    const tail = logs && logs.length > 0 ? `\nLog: ${logs.slice(-2).join(' | ')}` : '';
    return `Instruksi ${failedIx ?? '?'} gagal: ada akun token (mint / ATA / vault) yang belum terinisialisasi — cek urutan CreateIdempotent ATA sebelum MintTo/TransferChecked.${tail}`;
  }
  return logs && logs.length > 0 ? `${raw}\nLog: ${logs.slice(-3).join(' | ')}` : raw;
};

const programLabel = (ix: TransactionInstruction): string => {
  const id = ix.programId;
  if (id.equals(TOKEN_2022_PROGRAM_ID)) return 'Token-2022';
  if (id.equals(TOKEN_PROGRAM_ID)) return 'SPL Token';
  if (id.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) return 'ATA';
  if (id.equals(SystemProgram.programId)) return 'System';
  if (id.equals(ComputeBudgetProgram.programId)) return 'ComputeBudget';
  return id.toBase58().slice(0, 8) + '…';
};

/** Cetak ringkasan layout transaksi ke console (bantu debugging instruksi mana yang gagal). */
const logTxLayout = (
  label: string,
  instructions: TransactionInstruction[]
): void => {
  console.info(`[${label}] ${instructions.length} instruksi — build ${SDK_BUILD_TAG}`);
  console.table(
    instructions.map((ix, i) => ({
      '#': i,
      program: programLabel(ix),
      akun: ix.keys.length,
      tag: ix.data.length > 0 ? ix.data[0] : -1,
      bytes: ix.data.byteLength,
    }))
  );
};

/**
 * Penjaga layout `MintToChecked` (ix `u8 = 14`).
 *
 * Versi SDK lama mengirim 4 `AccountMeta` `[mint, mint, destination, authority]`
 * (layout `TransferChecked`). Akibatnya Token-2022 membaca akun **Mint** sebagai
 * `destination` dan transaksi gagal di preflight dengan
 * `Error processing Instruction 8: instruction requires an initialized account`.
 * Guard ini mengubah kegagalan simulasi yang membingungkan menjadi pesan yang jelas.
 */
const assertMintToCheckedLayout = (
  instructions: TransactionInstruction[],
  expectedDestination: PublicKey
): void => {
  instructions.forEach((ix, index) => {
    if (ix.data.length === 0 || ix.data[0] !== 14) return;
    const destination = ix.keys[1]?.pubkey;
    if (ix.keys.length !== 3 || !destination || !destination.equals(expectedDestination)) {
      throw new Error(
        `Layout MintToChecked salah di instruksi #${index}: ${ix.keys.length} akun (harus 3 = [mint, destination ATA, mint_authority]). ` +
          'Kode yang berjalan masih versi lama — jalankan "git pull" di folder proyek, restart "npm run dev", lalu hard reload browser (Ctrl+Shift+R).'
      );
    }
  });
};

class SandboxBinaryConnection extends Connection {
  private readonly accounts = new Map<string, AccountInfo<Buffer>>();

  constructor() {
    super(DEVNET_RPC_ENDPOINT, 'confirmed');
  }

  public writeRawAccount(pubkey: PublicKey, info: AccountInfo<Buffer>): void {
    this.accounts.set(pubkey.toBase58(), info);
  }

  public override async getMinimumBalanceForRentExemption(
    dataLength: number
  ): Promise<number> {
    return (128 + dataLength) * 6960;
  }

  public override async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 320_000_000,
    };
  }

  public override async getAccountInfo(
    publicKey: PublicKey,
    _commitmentOrConfig?: Commitment
  ): Promise<AccountInfo<Buffer> | null> {
    return this.accounts.get(publicKey.toBase58()) ?? null;
  }

  public override async getMultipleAccountsInfo(
    publicKeys: PublicKey[],
    _commitmentOrConfig?: Commitment
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    return publicKeys.map((pk) => this.accounts.get(pk.toBase58()) ?? null);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const shortenAddress = (addr: string, chars = 6): string =>
  addr.length <= chars * 2 + 3
    ? addr
    : `${addr.slice(0, chars)}...${addr.slice(-chars)}`;

export default function App(): React.ReactElement {
  // Cluster & Wallet State
  const [executionMode, setExecutionMode] = useState<'SANDBOX' | 'DEVNET'>(
    'SANDBOX'
  );
  const [walletPubkey, setWalletPubkey] = useState<PublicKey | null>(null);
  const [walletType, setWalletType] = useState<'INJECTED' | 'EPHEMERAL' | null>(
    null
  );
  const [ephemeralKeypair] = useState<Keypair>(() => Keypair.generate());

  // Unified Token-2022 + Virtual Liquidity Form State
  const [tokenStandard, setTokenStandard] =
    useState<TokenStandardMode>('TOKEN_2022');
  const [tokenName, setTokenName] = useState<string>('Nusantara Token 2022');
  const [ticker, setTicker] = useState<string>('NUSA');
  const [imageUri, setImageUri] = useState<string>(
    'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'
  );
  // URI JSON metadata (mis. hasil `npm run pinata:upload`); opsional.
  const [metadataUri, setMetadataUri] = useState<string>('');

  // Upload gambar ke IPFS lewat dev API `/api/pinata/upload` (khusus `npm run dev`).
  const [pinataUploadBusy, setPinataUploadBusy] = useState<boolean>(false);
  const [pinataUploadError, setPinataUploadError] = useState<string | null>(null);
  const [pinataStatus, setPinataStatus] = useState<{
    configured: boolean;
    message: string;
  } | null>(null);
  const [telegram, setTelegram] = useState<string>('https://t.me/nusa_2022');
  const [twitter, setTwitter] = useState<string>('https://x.com/nusa_2022');
  const [totalSupply, setTotalSupply] = useState<string>('1000000000');
  const [virtualSolLiquidity, setVirtualSolLiquidity] = useState<string>('30');
  const [initialBuySol, setInitialBuySol] = useState<string>('0');

  // Execution & Deserialized Pool State
  const [stage, setStage] = useState<LaunchStage>('IDLE');
  const [statusBanner, setStatusBanner] = useState<string>(
    'Siap — Luncurkan Token-2022 (MetadataPointer + On-Chain Socials) & Virtual Liquidity AMM'
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [claimBusy, setClaimBusy] = useState<boolean>(false);
  const [steps, setSteps] = useState<PipelineStepLog[]>([
    {
      step: 1,
      label: 'Clone Token-2022 + Native MetadataPointer & On-Chain Fields',
      status: 'pending',
    },
    {
      step: 2,
      label: 'Initialize Virtual Liquidity Pool (transfer_checked 100% Supply)',
      status: 'pending',
    },
    {
      step: 3,
      label: 'Initial SOL Swap (Opsional pada Detik ke-0)',
      status: 'pending',
    },
    {
      step: 4,
      label: 'Fetch & Unpack 281-Byte PoolState + Vaults + Fee Vault',
      status: 'pending',
    },
  ]);

  const [poolInfo, setPoolInfo] = useState<DeserializedPoolInfo | null>(null);
  const [userTokenBalanceRaw, setUserTokenBalanceRaw] = useState<bigint>(0n);
  const [telemetry, setTelemetry] = useState<BinaryTelemetry | null>(null);

  // Status devnet: saldo SOL wallet & proses airdrop
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [airdropBusy, setAirdropBusy] = useState<boolean>(false);

  // Interactive Swap Terminal State
  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL'>('BUY');
  const [tradeAmountInput, setTradeAmountInput] = useState<string>('5');

  const sandboxConnection = useMemo(() => new SandboxBinaryConnection(), []);
  const devnetConnection = useMemo(
    () => new Connection(DEVNET_RPC_ENDPOINT, 'confirmed'),
    []
  );

  const readSolBalance = async (
    conn: Connection,
    pubkey: PublicKey
  ): Promise<number | null> => {
    try {
      const lamports = await conn.getBalance(pubkey, 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      return null;
    }
  };

  const refreshSolBalance = async (
    conn: Connection,
    pubkey: PublicKey | null | undefined
  ): Promise<void> => {
    if (!pubkey || executionMode !== 'DEVNET') {
      setSolBalance(null);
      return;
    }
    setSolBalance(await readSolBalance(conn, pubkey));
  };

  // Cek kesiapan endpoint Pinata di dev server (tidak tersedia di build produksi).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/pinata/status');
        const data = (await res.json()) as { configured?: boolean; message?: string };
        if (!cancelled) {
          setPinataStatus({
            configured: data.configured === true,
            message: data.message ?? '',
          });
        }
      } catch {
        if (!cancelled) {
          setPinataStatus({
            configured: false,
            message:
              'Endpoint upload Pinata hanya aktif saat `npm run dev` (bukan build produksi).',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Unggah gambar token ke IPFS via Pinata lewat dev API, lalu isi otomatis
   * kolom Image URI (`imageUri`) dan Metadata JSON URI (`metadataUri`).
   */
  const handlePinataUpload = async (file: File): Promise<void> => {
    setPinataUploadError(null);
    setPinataUploadBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const raw = String(reader.result ?? '');
          const comma = raw.indexOf(',');
          resolve(comma >= 0 ? raw.slice(comma + 1) : raw);
        };
        reader.onerror = () => reject(new Error('Gagal membaca file dari disk'));
        reader.readAsDataURL(file);
      });

      const res = await fetch('/api/pinata/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          base64,
          name: tokenName,
          symbol: ticker,
          telegram,
          twitter,
        }),
      });

      const data = (await res.json()) as {
        imageUri?: string;
        metadataUri?: string;
        error?: string;
        detail?: string;
      };

      if (!res.ok || !data.imageUri || !data.metadataUri) {
        throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? `HTTP ${res.status}`));
      }

      setImageUri(data.imageUri);
      setMetadataUri(data.metadataUri);
      setStatusBanner('Gambar & metadata berhasil diunggah ke IPFS via Pinata');
    } catch (err) {
      setPinataUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setPinataUploadBusy(false);
    }
  };

  const handleConnectWallet = async (preferInjected: boolean): Promise<void> => {
    setErrorMessage(null);
    if (preferInjected && window.solana) {
      try {
        const res = await window.solana.connect();
        setWalletPubkey(res.publicKey);
        setWalletType('INJECTED');
        setStatusBanner(
          `Wallet Terhubung (${shortenAddress(res.publicKey.toBase58())})`
        );
        await refreshSolBalance(devnetConnection, res.publicKey);
        return;
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Gagal menghubungkan wallet'
        );
        return;
      }
    }

    setWalletPubkey(ephemeralKeypair.publicKey);
    setWalletType('EPHEMERAL');
    setStatusBanner(
      `Mock Keypair Terhubung (${shortenAddress(ephemeralKeypair.publicKey.toBase58())})`
    );
    await refreshSolBalance(devnetConnection, ephemeralKeypair.publicKey);
  };

  const handleDisconnectWallet = async (): Promise<void> => {
    if (walletType === 'INJECTED' && window.solana) {
      await window.solana.disconnect().catch(() => undefined);
    }
    setWalletPubkey(null);
    setWalletType(null);
    setSolBalance(null);
    setStatusBanner('Wallet terputus');
  };

  /**
   * Airdrop devnet untuk wallet ephemeral (mock) agar mode "Devnet RPC" bisa dipakai
   * tanpa Phantom. RPC publik sering membatasi airdrop; bila gagal, pakai faucet.solana.com.
   */
  const handleAirdrop = async (): Promise<void> => {
    const target = walletPubkey ?? ephemeralKeypair.publicKey;
    setErrorMessage(null);
    setAirdropBusy(true);
    try {
      if (executionMode !== 'DEVNET') {
        throw new Error('Airdrop hanya tersedia pada mode Devnet RPC');
      }
      const signature = await devnetConnection.requestAirdrop(
        target,
        LAMPORTS_PER_SOL
      );
      const latest = await devnetConnection.getLatestBlockhash('confirmed');
      const confirmation = await devnetConnection.confirmTransaction(
        {
          signature,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed'
      );
      if (confirmation.value.err) {
        throw new Error(JSON.stringify(confirmation.value.err));
      }
      setStatusBanner(
        `Airdrop 1 SOL devnet berhasil (${shortenAddress(target.toBase58(), 5)})`
      );
      await refreshSolBalance(devnetConnection, target);
    } catch (err) {
      setErrorMessage(
        `Airdrop gagal: ${
          err instanceof Error ? err.message : String(err)
        }. Coba faucet.solana.com atau ganti VITE_RPC_ENDPOINT.`
      );
    } finally {
      setAirdropBusy(false);
    }
  };

  const updateStep = (
    stepNum: number,
    patch: Partial<PipelineStepLog>
  ): void => {
    setSteps((prev) =>
      prev.map((item) =>
        item.step === stepNum ? { ...item, ...patch } : item
      )
    );
  };

  const signAndDispatch = async (
    tx: Transaction,
    extraSigners: Keypair[],
    conn: Connection
  ): Promise<{ signature: string; byteLength: number }> => {
    if (!tx.feePayer) {
      throw new Error('feePayer transaksi belum diset');
    }

    // Ambil blockhash + lastValidBlockHeight SEKALI, pakai pasangan yang sama saat
    // sign & confirm (versi lama memakai blockhash baru setelah kirim, sehingga
    // deteksi kedaluwarsa salah dan kegagalan on-chain tidak pernah terdeteksi).
    let blockhash = tx.recentBlockhash;
    let lastValidBlockHeight: number | undefined;
    if (executionMode === 'DEVNET') {
      const latest = await conn.getLatestBlockhash('confirmed');
      blockhash = latest.blockhash;
      lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.recentBlockhash = latest.blockhash;
    }

    if (extraSigners.length > 0) {
      tx.partialSign(...extraSigners);
    }
    if (walletType === 'EPHEMERAL' || !walletType) {
      tx.partialSign(ephemeralKeypair);
    } else if (walletType === 'INJECTED' && window.solana) {
      tx = await window.solana.signTransaction(tx);
    } else {
      throw new Error('Wallet injeksi tidak tersedia — hubungkan Phantom ulang');
    }

    const rawTx = tx.serialize();
    if (executionMode === 'SANDBOX') {
      await sleep(300);
      const sig =
        Keypair.generate().publicKey.toBase58() +
        Keypair.generate().publicKey.toBase58().slice(0, 40);
      return { signature: sig, byteLength: rawTx.byteLength };
    }

    try {
      const signature = await conn.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      const confirmation = await conn.confirmTransaction(
        {
          signature,
          blockhash: blockhash as string,
          lastValidBlockHeight: lastValidBlockHeight as number,
        },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(
          `Transaksi ${signature} gagal on-chain: ${JSON.stringify(
            confirmation.value.err
          )}`
        );
      }

      await refreshSolBalance(conn, tx.feePayer);
      return { signature, byteLength: rawTx.byteLength };
    } catch (err) {
      throw new Error(describeRpcError(err, conn.rpcEndpoint));
    }
  };

  /**
   * Menulis akun biner `PoolState` (281B), `vault_x` (165B SPL), `vault_y` (165B Token-2022),
   * dan `lp_mint` (82B Token-2022) ke Sandbox Ledger agar `fetchPoolInfo()` menjalankan
   * jalur deserialisasi `PoolStateLayout.decode()` yang sesungguhnya.
   */
  const commitSandboxState = (params: {
    poolAddress: PublicKey;
    tokenX: PublicKey;
    tokenY: PublicKey;
    vaultX: PublicKey;
    vaultY: PublicKey;
    lpMint: PublicKey;
    /** Fee vault creator (fee 0.06% per swap) */
    feeVaultX: PublicKey;
    feeVaultY: PublicKey;
    creator: PublicKey;
    creatorFeeX?: bigint;
    creatorFeeY?: bigint;
    tokenProgramY: PublicKey;
    realX: bigint;
    realY: bigint;
    virtualX: bigint;
    virtualY: bigint;
    lpSupply: bigint;
    bump: number;
  }): void => {
    const poolBuf = Buffer.alloc(POOL_STATE_SIZE);
    PoolStateLayout.encode(
      {
        discriminator: POOL_STATE_DISCRIMINATOR,
        tokenX: params.tokenX,
        tokenY: params.tokenY,
        vaultX: params.vaultX,
        vaultY: params.vaultY,
        lpMint: params.lpMint,
        creator: params.creator,
        feeVaultX: params.feeVaultX,
        feeVaultY: params.feeVaultY,
        virtualReservesX: params.virtualX,
        virtualReservesY: params.virtualY,
        bump: params.bump,
      },
      poolBuf
    );
    sandboxConnection.writeRawAccount(params.poolAddress, {
      data: poolBuf,
      executable: false,
      lamports: 2_150_000,
      owner: DEFAULT_AMM_PROGRAM_ID,
      rentEpoch: 0,
    });

    const vaultXBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
    SPL_TOKEN_ACCOUNT_LAYOUT.encode(
      {
        mint: params.tokenX,
        owner: params.poolAddress,
        amount: params.realX,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 1,
        isNative: 2_039_280n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      vaultXBuf
    );
    sandboxConnection.writeRawAccount(params.vaultX, {
      data: vaultXBuf,
      executable: false,
      lamports: 2_039_280,
      owner: TOKEN_PROGRAM_ID,
      rentEpoch: 0,
    });

    const vaultYBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
    SPL_TOKEN_ACCOUNT_LAYOUT.encode(
      {
        mint: params.tokenY,
        owner: params.poolAddress,
        amount: params.realY,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: 0,
        isNative: 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      vaultYBuf
    );
    sandboxConnection.writeRawAccount(params.vaultY, {
      data: vaultYBuf,
      executable: false,
      lamports: 2_039_280,
      owner: params.tokenProgramY,
      rentEpoch: 0,
    });

    // Fee vault creator (0.06% per swap) — ditulis agar `fetchPoolInfo()` membaca
    // `creatorFeeX` / `creatorFeeY` lewat jalur deserialisasi yang sama.
    const writeFeeVault = (
      address: PublicKey,
      mint: PublicKey,
      programId: PublicKey,
      amount: bigint
    ): void => {
      const buf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
      SPL_TOKEN_ACCOUNT_LAYOUT.encode(
        {
          mint,
          owner: params.poolAddress,
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
      sandboxConnection.writeRawAccount(address, {
        data: buf,
        executable: false,
        lamports: 2_039_280,
        owner: programId,
        rentEpoch: 0,
      });
    };
    writeFeeVault(params.feeVaultX, params.tokenX, TOKEN_PROGRAM_ID, params.creatorFeeX ?? 0n);
    writeFeeVault(
      params.feeVaultY,
      params.tokenY,
      params.tokenProgramY,
      params.creatorFeeY ?? 0n
    );

    const lpMintBuf = Buffer.alloc(SPL_MINT_SIZE);
    SPL_MINT_ACCOUNT_LAYOUT.encode(
      {
        mintAuthorityOption: 1,
        mintAuthority: params.poolAddress,
        supply: params.lpSupply,
        decimals: DEFAULT_TOKEN_DECIMALS,
        isInitialized: 1,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      lpMintBuf
    );
    sandboxConnection.writeRawAccount(params.lpMint, {
      data: lpMintBuf,
      executable: false,
      lamports: 1_461_600,
      owner: TOKEN_2022_PROGRAM_ID,
      rentEpoch: 0,
    });
  };

  /**
   * Pipeline Utama: Clone Token-2022 -> Initialize Virtual Liquidity Pool -> Optional Buy -> Fetch Pool Info
   */
  const handleLaunchPlatform = async (
    e: React.FormEvent<HTMLFormElement>
  ): Promise<void> => {
    e.preventDefault();
    setErrorMessage(null);

    const activePayer = walletPubkey ?? ephemeralKeypair.publicKey;
    if (!walletPubkey) {
      setWalletPubkey(ephemeralKeypair.publicKey);
      setWalletType('EPHEMERAL');
    }

    setPoolInfo(null);
    setUserTokenBalanceRaw(0n);
    setTelemetry(null);
    setSteps([
      {
        step: 1,
        label:
          tokenStandard === 'TOKEN_2022'
            ? 'Clone Token-2022 + MetadataPointer & On-Chain Socials'
            : 'Clone SPL Legacy + Metaplex Metadata V3',
        status: 'pending',
      },
      {
        step: 2,
        label: 'Initialize Virtual Liquidity Pool (transfer_checked)',
        status: 'pending',
      },
      {
        step: 3,
        label: 'Initial SOL Swap (Opsional pada Detik ke-0)',
        status: 'pending',
      },
      {
        step: 4,
        label: 'Fetch & Unpack 281-Byte PoolState + Vaults + Fee Vault',
        status: 'pending',
      },
    ]);

    const activeConnection =
      executionMode === 'SANDBOX' ? sandboxConnection : devnetConnection;
    const sdk = new CustomDefiSDK(activeConnection, DEFAULT_AMM_PROGRAM_ID);

    try {
      // Guard devnet: tanpa SOL, transaksi pertama sudah gagal di preflight.
      if (executionMode === 'DEVNET') {
        const balance = await readSolBalance(devnetConnection, activePayer);
        setSolBalance(balance);
        if (balance === null) {
          throw new Error(
            `Tidak bisa membaca saldo dari ${DEVNET_RPC_HOST}. Periksa koneksi / ganti VITE_RPC_ENDPOINT.`
          );
        }
        if (balance < MIN_DEVNET_SOL) {
          throw new Error(
            `Saldo devnet ${balance.toFixed(4)} SOL kurang dari ${MIN_DEVNET_SOL} SOL. Klik "Airdrop 1 SOL" (mock keypair) atau hubungkan Phantom yang punya SOL devnet.`
          );
        }
      }

      const supplyRaw = parseTokenAmount(totalSupply, DEFAULT_TOKEN_DECIMALS);
      const virtualSolRaw = parseTokenAmount(
        virtualSolLiquidity,
        DEFAULT_TOKEN_DECIMALS
      );
      const firstBuySolRaw = parseTokenAmount(
        initialBuySol || '0',
        DEFAULT_TOKEN_DECIMALS
      );

      if (supplyRaw <= 0n || virtualSolRaw <= 0n) {
        throw new Error(
          'Total Supply dan Virtual SOL Liquidity harus lebih besar dari 0'
        );
      }

      // ----------------------------------------------------------------------
      // STEP 1: Clone Token-2022 (MetadataPointer + TokenMetadata + UpdateField)
      // ----------------------------------------------------------------------
      setStage('MINTING_TOKEN');
      setStatusBanner(
        tokenStandard === 'TOKEN_2022'
          ? 'Minting Token-2022 + Menyimpan Nama, Simbol, URI & Sosial On-Chain...'
          : 'Minting SPL Token + Metaplex Metadata V3...'
      );
      updateStep(1, {
        status: 'active',
        detail: 'Menyusun instruksi biner alokasi Mint, Metadata & MintToChecked...',
      });

      const cloneResult = await sdk.buildCloneTokenInstructions({
        payer: activePayer,
        name: tokenName,
        symbol: ticker,
        imageUri,
        metadataUri: metadataUri.trim() || undefined,
        telegram,
        twitter,
        decimals: DEFAULT_TOKEN_DECIMALS,
        initialSupplyRaw: supplyRaw,
        tokenStandard,
      });

      const cloneTx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: CLONE_TX_COMPUTE_UNITS,
        }),
        ...cloneResult.instructions
      );
      cloneTx.feePayer = activePayer;
      cloneTx.recentBlockhash = (
        await activeConnection.getLatestBlockhash('confirmed')
      ).blockhash;

      assertMintToCheckedLayout(cloneResult.instructions, cloneResult.userTokenAta);
      logTxLayout('clone-tx', cloneTx.instructions);

      await signAndDispatch(
        cloneTx,
        [cloneResult.mintKeypair],
        activeConnection
      );

      updateStep(1, {
        status: 'done',
        detail: `Mint ${shortenAddress(cloneResult.mint.toBase58())} (${cloneResult.allocatedMintBytes}B Mint, ${cloneResult.instructions.length} raw ixs)`,
      });

      // ----------------------------------------------------------------------
      // STEP 2: Initialize Virtual Pool (`initialize_pool` — Discriminator 0)
      // ----------------------------------------------------------------------
      setStage('INITIALIZING_POOL');
      setStatusBanner(
        'Initializing Hybrid Token-2022 Virtual Liquidity Pool (0 Real SOL)...'
      );
      updateStep(2, {
        status: 'active',
        detail: 'Serialisasi 17B BufferLayout + transfer_checked 100% suplai ke vault_y...',
      });

      const createPoolResult = await sdk.buildCreatePoolTx({
        payer: activePayer,
        tokenX: NATIVE_SOL_MINT,
        tokenY: cloneResult.mint,
        initialRealTokenY: supplyRaw,
        virtualReservesX: virtualSolRaw,
        tokenProgramX: TOKEN_PROGRAM_ID,
        tokenProgramY: cloneResult.tokenProgramId,
        tokenProgramLp: TOKEN_2022_PROGRAM_ID,
      });

      await signAndDispatch(
        withComputeBudget(createPoolResult.transaction, AMM_TX_COMPUTE_UNITS),
        [],
        activeConnection
      );

      let realX = 0n;
      let realY = supplyRaw;
      let lastSwapHex: string | undefined;

      if (executionMode === 'SANDBOX') {
        commitSandboxState({
          poolAddress: createPoolResult.addresses.poolState,
          tokenX: NATIVE_SOL_MINT,
          tokenY: cloneResult.mint,
          vaultX: createPoolResult.addresses.vaultX,
          vaultY: createPoolResult.addresses.vaultY,
          lpMint: createPoolResult.addresses.lpMint,
          feeVaultX: createPoolResult.addresses.feeVaultX,
          feeVaultY: createPoolResult.addresses.feeVaultY,
          creator: activePayer,
          tokenProgramY: cloneResult.tokenProgramId,
          realX,
          realY,
          virtualX: virtualSolRaw,
          // `initialize_pool` menyimpan virtual_reserves_y = 0: seluruh suplai token
          // fisik sudah berada di `vault_y`, jadi token Y tidak boleh dihitung dua kali.
          virtualY: 0n,
          lpSupply: createPoolResult.expectedInitialLp,
          bump: createPoolResult.addresses.poolBump,
        });
      }

      updateStep(2, {
        status: 'done',
        detail: `Pool ${shortenAddress(createPoolResult.addresses.poolState.toBase58())} | LP Awal: ${formatTokenAmount(createPoolResult.expectedInitialLp, 9, 2)}`,
      });

      // ----------------------------------------------------------------------
      // STEP 3: Optional First Swap (`swap` — Discriminator 2)
      // ----------------------------------------------------------------------
      if (firstBuySolRaw > 0n) {
        setStage('INITIAL_SWAP');
        setStatusBanner('Mengeksekusi Pembelian Awal via Token-2022 transfer_checked...');
        updateStep(3, {
          status: 'active',
          detail: `Membeli dengan ${formatTokenAmount(firstBuySolRaw)} SOL...`,
        });

        // Cadangan efektif = vault.amount + virtual_reserves (virtual_reserves_y = 0).
        const totalX = realX + virtualSolRaw;
        const totalY = realY;
        const expectedOut = calculateSwapOutput(firstBuySolRaw, totalX, totalY);

        const swapBuild = await sdk.buildSwapTx({
          user: activePayer,
          tokenX: NATIVE_SOL_MINT,
          tokenY: cloneResult.mint,
          amountIn: firstBuySolRaw,
          minAmountOut: expectedOut,
          xToY: true,
          tokenProgramX: TOKEN_PROGRAM_ID,
          tokenProgramY: cloneResult.tokenProgramId,
        });

        await signAndDispatch(
          withComputeBudget(swapBuild.transaction, AMM_TX_COMPUTE_UNITS),
          [],
          activeConnection
        );
        lastSwapHex = swapBuild.serializedIxData.toString('hex');

        realX += firstBuySolRaw;
        realY -= expectedOut;
        setUserTokenBalanceRaw(expectedOut);

        if (executionMode === 'SANDBOX') {
          commitSandboxState({
            poolAddress: createPoolResult.addresses.poolState,
            tokenX: NATIVE_SOL_MINT,
            tokenY: cloneResult.mint,
            vaultX: createPoolResult.addresses.vaultX,
            vaultY: createPoolResult.addresses.vaultY,
            lpMint: createPoolResult.addresses.lpMint,
            feeVaultX: createPoolResult.addresses.feeVaultX,
            feeVaultY: createPoolResult.addresses.feeVaultY,
            creator: activePayer,
            creatorFeeX: calculateCreatorFee(firstBuySolRaw),
            tokenProgramY: cloneResult.tokenProgramId,
            realX,
            realY,
            virtualX: virtualSolRaw,
            virtualY: 0n,
            lpSupply: createPoolResult.expectedInitialLp,
            bump: createPoolResult.addresses.poolBump,
          });
        }

        updateStep(3, {
          status: 'done',
          detail: `Diterima ${formatTokenAmount(expectedOut, 9, 2)} ${ticker.toUpperCase()}`,
        });
      } else {
        updateStep(3, {
          status: 'done',
          detail: 'Dilewati (0 SOL Modal Riil Awal)',
        });
      }

      // ----------------------------------------------------------------------
      // STEP 4: Fetch & Unpack 281-Byte PoolState + Vault Reserves + Fee Vault
      // ----------------------------------------------------------------------
      setStage('FETCHING_POOL');
      setStatusBanner('Membaca & Deserialisasi PoolState + Token-2022 Vaults...');
      updateStep(4, {
        status: 'active',
        detail: 'Unpacking 281B PoolStateLayout + 165B Vaults + Fee Vault...',
      });

      await sleep(200);
      const unpacked = await sdk.fetchPoolInfo(
        NATIVE_SOL_MINT,
        cloneResult.mint
      );

      setTelemetry({
        mintAddress: cloneResult.mint.toBase58(),
        tokenStandard: cloneResult.tokenStandard,
        tokenProgramY: cloneResult.tokenProgramId.toBase58(),
        allocatedMintBytes: cloneResult.allocatedMintBytes,
        additionalMetadata: cloneResult.additionalMetadata,
        createPoolIxHex: createPoolResult.serializedIxData.toString('hex'),
        lastSwapIxHex: lastSwapHex,
        cloneIxCount: cloneResult.instructions.length,
      });

      setPoolInfo(unpacked);
      updateStep(4, {
        status: 'done',
        detail: `281B PoolState Terbaca | Total Efektif X: ${formatTokenAmount(unpacked.totalReservesX, 9, 2)} SOL`,
      });

      setStage('SUCCESS');
      setStatusBanner(
        `Success! $${ticker.trim().toUpperCase()} (${cloneResult.tokenStandard}) aktif di Virtual Liquidity AMM`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Transaksi gagal';
      setStage('ERROR');
      setErrorMessage(msg);
      setStatusBanner(`Pipeline terhenti: ${msg}`);
      setSteps((prev) =>
        prev.map((item) =>
          item.status === 'active'
            ? { ...item, status: 'error', detail: msg }
            : item
        )
      );
    }
  };

  // Estimasi Swap Real-time (`total_reserve = vault.amount + virtual_reserves`)
  const swapQuote = useMemo(() => {
    if (!poolInfo) return null;
    try {
      const amountInRaw = parseTokenAmount(
        tradeAmountInput,
        DEFAULT_TOKEN_DECIMALS
      );
      if (amountInRaw <= 0n) return null;

      const isBuy = tradeSide === 'BUY';
      const reserveIn = isBuy
        ? poolInfo.totalReservesX
        : poolInfo.totalReservesY;
      const reserveOut = isBuy
        ? poolInfo.totalReservesY
        : poolInfo.totalReservesX;

      const amountOut = calculateSwapOutput(amountInRaw, reserveIn, reserveOut);
      const vaultAvailable = isBuy
        ? poolInfo.realReservesY
        : poolInfo.realReservesX;
      if (amountOut > vaultAvailable) {
        return null;
      }

      return {
        amountInRaw,
        amountOut,
        feeRaw: (amountInRaw * 3n) / 1000n,
      };
    } catch {
      return null;
    }
  }, [poolInfo, tradeAmountInput, tradeSide]);

  const handleExecuteSwap = async (): Promise<void> => {
    if (!poolInfo || !swapQuote) return;
    setErrorMessage(null);

    const activeUser = walletPubkey ?? ephemeralKeypair.publicKey;
    const activeConnection =
      executionMode === 'SANDBOX' ? sandboxConnection : devnetConnection;
    const sdk = new CustomDefiSDK(activeConnection, DEFAULT_AMM_PROGRAM_ID);

    try {
      if (
        tradeSide === 'SELL' &&
        executionMode === 'SANDBOX' &&
        swapQuote.amountInRaw > userTokenBalanceRaw
      ) {
        throw new Error(
          `Saldo ${ticker.toUpperCase()} Anda (${formatTokenAmount(userTokenBalanceRaw, 9, 2)}) tidak mencukupi`
        );
      }

      setStage('SWAPPING');
      const isBuy = tradeSide === 'BUY';
      setStatusBanner(
        isBuy
          ? `Swap ${tradeAmountInput} SOL -> $${ticker.toUpperCase()} (Token-2022 transfer_checked)...`
          : `Swap ${tradeAmountInput} $${ticker.toUpperCase()} -> SOL (Token-2022 transfer_checked)...`
      );

      if (executionMode === 'DEVNET' && isBuy) {
        const balance = await readSolBalance(devnetConnection, activeUser);
        setSolBalance(balance);
        if (balance !== null && balance < MIN_DEVNET_SOL) {
          throw new Error(
            `Saldo devnet ${balance.toFixed(4)} SOL tidak cukup untuk swap. Lakukan airdrop terlebih dahulu.`
          );
        }
      }

      const swapBuild = await sdk.buildSwapTx({
        user: activeUser,
        tokenX: poolInfo.tokenX,
        tokenY: poolInfo.tokenY,
        amountIn: swapQuote.amountInRaw,
        minAmountOut: swapQuote.amountOut,
        xToY: isBuy,
        tokenProgramX: poolInfo.tokenProgramX,
        tokenProgramY: poolInfo.tokenProgramY,
        // Saat menjual, WSOL hasil swap dicairkan menjadi SOL native.
        unwrapWsol: !isBuy,
      });

      await signAndDispatch(
        withComputeBudget(swapBuild.transaction, AMM_TX_COMPUTE_UNITS),
        [],
        activeConnection
      );

      if (executionMode === 'SANDBOX') {
        const nextRealX = isBuy
          ? poolInfo.realReservesX + swapQuote.amountInRaw
          : poolInfo.realReservesX - swapQuote.amountOut;
        const nextRealY = isBuy
          ? poolInfo.realReservesY - swapQuote.amountOut
          : poolInfo.realReservesY + swapQuote.amountInRaw;

        const creatorFeeRaw = calculateCreatorFee(swapQuote.amountInRaw);
        commitSandboxState({
          poolAddress: poolInfo.poolAddress,
          tokenX: poolInfo.tokenX,
          tokenY: poolInfo.tokenY,
          vaultX: poolInfo.vaultX,
          vaultY: poolInfo.vaultY,
          lpMint: poolInfo.lpMint,
          feeVaultX: poolInfo.feeVaultX,
          feeVaultY: poolInfo.feeVaultY,
          creator: poolInfo.creator,
          // Fee creator 0.06% diakumulasi ke fee vault sisi input.
          creatorFeeX:
            poolInfo.creatorFeeX + (isBuy ? creatorFeeRaw : 0n),
          creatorFeeY:
            poolInfo.creatorFeeY + (isBuy ? 0n : creatorFeeRaw),
          tokenProgramY: poolInfo.tokenProgramY,
          realX: nextRealX,
          realY: nextRealY,
          virtualX: poolInfo.virtualReservesX,
          virtualY: poolInfo.virtualReservesY,
          lpSupply: poolInfo.lpSupply,
          bump: poolInfo.bump,
        });

        setUserTokenBalanceRaw((prev) =>
          isBuy ? prev + swapQuote.amountOut : prev - swapQuote.amountInRaw
        );
      }

      const refreshed = await sdk.fetchPoolInfo(poolInfo.poolAddress);
      setPoolInfo(refreshed);
      setTelemetry((prev) =>
        prev
          ? {
              ...prev,
              lastSwapIxHex: swapBuild.serializedIxData.toString('hex'),
            }
          : prev
      );

      setStage('SUCCESS');
      setStatusBanner(
        `Swap Selesai! Vault X (SOL Riil): ${formatTokenAmount(refreshed.realReservesX, 9, 4)} SOL`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Swap gagal';
      setStage('ERROR');
      setErrorMessage(msg);
      setStatusBanner(`Swap gagal: ${msg}`);
    }
  };

  /**
   * Klaim fee creator (0.06% per swap) dari `fee_vault_x` / `fee_vault_y`.
   * Di mode Devnet memakai transaksi `claim_creator_fee` sungguhan; di Sandbox
   * fee vault dikosongkan pada ledger lokal agar alur UI-nya tetap teruji.
   */
  const handleClaimCreatorFee = async (): Promise<void> => {
    if (!poolInfo) return;
    const activeUser = walletPubkey ?? ephemeralKeypair.publicKey;
    const activeConnection =
      executionMode === 'SANDBOX' ? sandboxConnection : devnetConnection;
    const sdk = new CustomDefiSDK(activeConnection, DEFAULT_AMM_PROGRAM_ID);

    setErrorMessage(null);

    if (!poolInfo.creator.equals(activeUser)) {
      setErrorMessage(
        `Hanya creator pool (${shortenAddress(poolInfo.creator.toBase58())}) yang bisa mengklaim fee ini. Wallet aktif: ${shortenAddress(activeUser.toBase58())}.`
      );
      return;
    }
    if (poolInfo.creatorFeeX === 0n && poolInfo.creatorFeeY === 0n) {
      setErrorMessage(
        'Belum ada fee creator yang terakumulasi — fee 0.06% baru terisi setelah ada swap.'
      );
      return;
    }

    try {
      setClaimBusy(true);
      setStatusBanner('Mengklaim fee creator (claim_creator_fee, disc 3)...');

      if (executionMode === 'SANDBOX') {
        commitSandboxState({
          poolAddress: poolInfo.poolAddress,
          tokenX: poolInfo.tokenX,
          tokenY: poolInfo.tokenY,
          vaultX: poolInfo.vaultX,
          vaultY: poolInfo.vaultY,
          lpMint: poolInfo.lpMint,
          feeVaultX: poolInfo.feeVaultX,
          feeVaultY: poolInfo.feeVaultY,
          creator: poolInfo.creator,
          creatorFeeX: 0n,
          creatorFeeY: 0n,
          tokenProgramY: poolInfo.tokenProgramY,
          realX: poolInfo.realReservesX,
          realY: poolInfo.realReservesY,
          virtualX: poolInfo.virtualReservesX,
          virtualY: poolInfo.virtualReservesY,
          lpSupply: poolInfo.lpSupply,
          bump: poolInfo.bump,
        });
      } else {
        const claim = await sdk.buildClaimCreatorFeeTx({
          creator: activeUser,
          tokenX: poolInfo.tokenX,
          tokenY: poolInfo.tokenY,
        });
        await signAndDispatch(claim.transaction, [], activeConnection);
      }

      const refreshed = await sdk.fetchPoolInfo(poolInfo.poolAddress);
      setPoolInfo(refreshed);
      setStatusBanner(
        `Fee creator terklaim — sisa X: ${formatTokenAmount(refreshed.creatorFeeX, 9, 6)} SOL, Y: ${formatTokenAmount(refreshed.creatorFeeY, 9, 6)} ${ticker.toUpperCase()}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Klaim fee creator gagal';
      setErrorMessage(msg);
      setStatusBanner(`Klaim fee creator gagal: ${msg}`);
    } finally {
      setClaimBusy(false);
    }
  };

  const isBusy =
    stage === 'MINTING_TOKEN' ||
    stage === 'INITIALIZING_POOL' ||
    stage === 'INITIAL_SWAP' ||
    stage === 'FETCHING_POOL' ||
    stage === 'SWAPPING';

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-800/90 bg-zinc-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 font-mono text-xs font-bold text-emerald-400">
              T22
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-100">
                Solana Token-2022 Launchpad &amp; Virtual Liquidity AMM
              </h1>
              <p className="font-mono text-xs text-zinc-400">
                Native <code className="text-emerald-400">TokenInterface</code>{' '}
                + <code className="text-cyan-300">transfer_checked</code> &bull;
                Zero External SDKs &bull; build{' '}
                <code className="text-zinc-300" title="Stempel layout SDK terbaru">
                  {SDK_BUILD_TAG}
                </code>
                {executionMode === 'DEVNET' && <> &bull; RPC {DEVNET_RPC_HOST}</>}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  setExecutionMode('SANDBOX');
                  setSolBalance(null);
                }}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  executionMode === 'SANDBOX'
                    ? 'bg-zinc-800 text-emerald-400 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Binary Sandbox
              </button>
              <button
                type="button"
                onClick={() => {
                  setExecutionMode('DEVNET');
                  void refreshSolBalance(
                    devnetConnection,
                    walletPubkey ?? ephemeralKeypair.publicKey
                  );
                }}
                className={`rounded-md px-2.5 py-1 font-medium transition ${
                  executionMode === 'DEVNET'
                    ? 'bg-zinc-800 text-cyan-400 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                Devnet RPC
              </button>
            </div>

            {walletPubkey ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="font-mono text-emerald-200">
                  {shortenAddress(walletPubkey.toBase58(), 5)}
                </span>
                <button
                  type="button"
                  onClick={handleDisconnectWallet}
                  className="ml-1 text-zinc-400 hover:text-zinc-100"
                >
                  &times;
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleConnectWallet(false)}
                  className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-3.5 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/25"
                >
                  Connect Mock Keypair
                </button>
                {typeof window !== 'undefined' && window.solana && (
                  <button
                    type="button"
                    onClick={() => handleConnectWallet(true)}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-600"
                  >
                    Phantom
                  </button>
                )}
              </div>
            )}

            {executionMode === 'DEVNET' && (
              <div className="flex items-center gap-2">
                <span
                  className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-300"
                  title={`Saldo ${walletPubkey ? shortenAddress(walletPubkey.toBase58()) : 'wallet'} di ${DEVNET_RPC_HOST}`}
                >
                  {solBalance === null ? '— SOL' : `${solBalance.toFixed(4)} SOL`}
                </span>
                {walletType !== 'INJECTED' && (
                  <button
                    type="button"
                    onClick={handleAirdrop}
                    disabled={airdropBusy || isBusy}
                    className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-medium text-cyan-300 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {airdropBusy ? 'Airdrop...' : 'Airdrop 1 SOL'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-7 lg:grid-cols-12">
        {/* Left Column: Unified Form */}
        <section className="lg:col-span-5">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">
                  1. Token-2022 &amp; Virtual Pool Setup
                </h2>
                <p className="text-xs text-zinc-400">
                  Self-Referential MetadataPointer + 0 Real SOL Init
                </p>
              </div>
              <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setTokenStandard('TOKEN_2022')}
                  className={`rounded px-2 py-0.5 font-mono transition ${
                    tokenStandard === 'TOKEN_2022'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : 'text-zinc-500'
                  }`}
                >
                  Token-2022
                </button>
                <button
                  type="button"
                  onClick={() => setTokenStandard('SPL_LEGACY')}
                  className={`rounded px-2 py-0.5 font-mono transition ${
                    tokenStandard === 'SPL_LEGACY'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'text-zinc-500'
                  }`}
                >
                  SPL
                </button>
              </div>
            </div>

            <form onSubmit={handleLaunchPlatform} className="space-y-3.5">
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Token Name
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={64}
                    value={tokenName}
                    onChange={(e) => setTokenName(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Ticker
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={12}
                    value={ticker}
                    onChange={(e) => setTicker(e.target.value.toUpperCase())}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm uppercase text-zinc-100 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-dashed border-zinc-700 bg-zinc-950/60 p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <label className="block text-xs font-medium text-zinc-300">
                    Upload gambar ke IPFS (Pinata)
                  </label>
                  {pinataStatus && (
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                        pinataStatus.configured
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                          : 'border-amber-400/40 bg-amber-400/10 text-amber-300'
                      }`}
                      title={pinataStatus.message}
                    >
                      {pinataStatus.configured ? 'PINATA SIAP' : 'BELUM DIKONFIGURASI'}
                    </span>
                  )}
                </div>

                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                  disabled={pinataUploadBusy || isBusy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handlePinataUpload(file);
                    e.target.value = '';
                  }}
                  className="block w-full text-xs text-zinc-300 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-emerald-500 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-zinc-950 disabled:opacity-50"
                />

                {pinataUploadBusy && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    Mengunggah gambar + metadata ke IPFS...
                  </p>
                )}
                {pinataUploadError && (
                  <p className="mt-1 text-[11px] text-rose-300">{pinataUploadError}</p>
                )}
                {!pinataUploadError && !pinataUploadBusy && pinataStatus && !pinataStatus.configured && (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    {pinataStatus.message} — alternatif: tempel URL hasil
                    <code className="mx-1 text-zinc-400">npm run pinata:upload</code>
                    ke kolom di bawah.
                  </p>
                )}
                {!pinataUploadError && !pinataUploadBusy && pinataStatus?.configured && (
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Pilih file &rarr; kedua kolom URI di bawah terisi otomatis.
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">
                  Image URI (IPFS / HTTPS)
                </label>
                <input
                  type="url"
                  required
                  value={imageUri}
                  onChange={(e) => setImageUri(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 outline-none focus:border-emerald-500"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  URL gambar (dipakai sebagai <code>image</code> di JSON metadata).
                </p>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">
                  Metadata JSON URI (opsional)
                </label>
                <input
                  type="url"
                  value={metadataUri}
                  onChange={(e) => setMetadataUri(e.target.value)}
                  placeholder="https://gateway.pinata.cloud/ipfs/Qm... (hasil npm run pinata:upload)"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-emerald-200 outline-none focus:border-emerald-500"
                />
                <p className="mt-1 text-[11px] text-zinc-500">
                  Jika diisi, <code>uri</code> on-chain menunjuk ke JSON ini (standar
                  wallet/explorer). Kosongkan untuk memakai Image URI langsung.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Telegram (On-Chain TLV)
                  </label>
                  <input
                    type="text"
                    value={telegram}
                    onChange={(e) => setTelegram(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Twitter / X (On-Chain TLV)
                  </label>
                  <input
                    type="text"
                    value={twitter}
                    onChange={(e) => setTwitter(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">
                  Total Supply (`initial_real_token_y`)
                </label>
                <input
                  type="text"
                  required
                  value={totalSupply}
                  onChange={(e) => setTotalSupply(e.target.value)}
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Virtual SOL (`virtual_reserves_x`)
                  </label>
                  <input
                    type="text"
                    required
                    value={virtualSolLiquidity}
                    onChange={(e) => setVirtualSolLiquidity(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-cyan-300 outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-zinc-300">
                    Initial Buy SOL (Opsional)
                  </label>
                  <input
                    type="text"
                    value={initialBuySol}
                    onChange={(e) => setInitialBuySol(e.target.value)}
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-emerald-300 outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-3 font-mono text-[11px] text-zinc-400">
                <div className="flex justify-between">
                  <span>Token X Program (WSOL):</span>
                  <span className="text-zinc-200">
                    {shortenAddress(TOKEN_PROGRAM_ID.toBase58(), 6)}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span>Token Y Program ({ticker.toUpperCase()}):</span>
                  <span className="text-emerald-400">
                    {shortenAddress(
                      (tokenStandard === 'TOKEN_2022'
                        ? TOKEN_2022_PROGRAM_ID
                        : TOKEN_PROGRAM_ID
                      ).toBase58(),
                      6
                    )}
                  </span>
                </div>
              </div>

              <button
                type="submit"
                disabled={isBusy}
                className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-emerald-500/10 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {stage === 'MINTING_TOKEN'
                  ? 'Minting Token-2022...'
                  : stage === 'INITIALIZING_POOL'
                    ? 'Initializing Pool...'
                    : stage === 'INITIAL_SWAP'
                      ? 'Executing Initial Swap...'
                      : stage === 'FETCHING_POOL'
                        ? 'Fetching PoolState...'
                        : 'Launch Token-2022 & Virtual Pool'}
              </button>
            </form>
          </div>
        </section>

        {/* Right Column: Pipeline, PoolState & Swap Terminal */}
        <section className="space-y-5 lg:col-span-7">
          {/* Pipeline Status */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    stage === 'SUCCESS'
                      ? 'bg-emerald-400'
                      : stage === 'ERROR'
                        ? 'bg-rose-500'
                        : isBusy
                          ? 'animate-pulse bg-amber-400'
                          : 'bg-zinc-600'
                  }`}
                />
                <span className="text-xs font-medium text-zinc-200">
                  {statusBanner}
                </span>
              </div>
              <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                {stage}
              </span>
            </div>

            {errorMessage && (
              <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                {errorMessage}
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              {steps.map((s) => (
                <div
                  key={s.step}
                  className={`rounded-lg border px-3 py-2 transition ${
                    s.status === 'done'
                      ? 'border-emerald-500/30 bg-emerald-500/5'
                      : s.status === 'active'
                        ? 'border-amber-400/40 bg-amber-400/5'
                        : s.status === 'error'
                          ? 'border-rose-500/40 bg-rose-500/5'
                          : 'border-zinc-800/80 bg-zinc-950/50'
                  }`}
                >
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate font-medium text-zinc-200">
                      <span className="mr-1.5 font-mono text-zinc-500">
                        0{s.step}
                      </span>
                      {s.label}
                    </span>
                    <span
                      className={`ml-2 font-mono text-[10px] uppercase ${
                        s.status === 'done'
                          ? 'text-emerald-400'
                          : s.status === 'active'
                            ? 'text-amber-300'
                            : s.status === 'error'
                              ? 'text-rose-400'
                              : 'text-zinc-600'
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  {s.detail && (
                    <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                      {s.detail}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          {poolInfo ? (
            <div className="space-y-5">
              {/* Deserialized PoolState & Vault Reserves */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-100">
                      Deserialized <code className="text-emerald-400">PoolState</code> (281B) +{' '}
                      <code className="text-cyan-300">TokenInterface</code> Vaults
                    </h3>
                    <p className="font-mono text-[11px] text-zinc-400">
                      Saldo Dompet Anda:{' '}
                      {formatTokenAmount(userTokenBalanceRaw, 9, 2)}{' '}
                      {ticker.toUpperCase()} &bull; LP Supply:{' '}
                      {formatTokenAmount(poolInfo.lpSupply, 9, 2)}
                    </p>
                  </div>
                  <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-3 py-0.5 font-mono text-[11px] text-emerald-300">
                    {telemetry?.tokenStandard ?? 'TOKEN_2022'}
                  </span>
                </div>

                <div className="grid gap-2.5 sm:grid-cols-2">
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-[11px] text-zinc-400">
                      vault_x.amount (Real SOL) + virtual_reserves_x
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-emerald-400">
                      {formatTokenAmount(poolInfo.realReservesX, 9, 4)} +{' '}
                      {formatTokenAmount(poolInfo.virtualReservesX, 9, 1)} ={' '}
                      {formatTokenAmount(poolInfo.totalReservesX, 9, 4)} SOL
                    </div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                    <div className="text-[11px] text-zinc-400">
                      vault_y.amount (Real {ticker.toUpperCase()})
                    </div>
                    <div className="mt-0.5 font-mono text-sm font-semibold text-zinc-100">
                      {formatTokenAmount(poolInfo.realReservesY, 9, 2)}{' '}
                      {ticker.toUpperCase()}
                    </div>
                  </div>
                </div>

                <div className="mt-3 grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px]">
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">pool_state PDA (bump={poolInfo.bump}):</span>
                    <span className="truncate text-zinc-200">
                      {poolInfo.poolAddress.toBase58()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">token_x (WSOL / SPL):</span>
                    <span className="truncate text-zinc-200">
                      {poolInfo.tokenX.toBase58()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">token_y (Token-2022 Mint):</span>
                    <span className="truncate text-emerald-300">
                      {poolInfo.tokenY.toBase58()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-zinc-500">token_program_y:</span>
                    <span className="truncate text-cyan-300">
                      {poolInfo.tokenProgramY.toBase58()}
                    </span>
                  </div>
                  {telemetry && telemetry.additionalMetadata.length > 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-500">
                        On-Chain TokenMetadata TLV ({telemetry.allocatedMintBytes}B):
                      </span>
                      <span className="truncate text-zinc-300">
                        {telemetry.additionalMetadata
                          .map(([k, v]) => `${k}=${v}`)
                          .join(' | ')}
                      </span>
                    </div>
                  )}
                  {telemetry && (
                    <div className="pt-1 text-[10px] text-zinc-500">
                      claim_creator_fee (10B):{' '}
                      <span className="text-amber-300">[3, side, min_amount]</span> |{' '}
                      initialize_pool (17B):{' '}
                      <span className="text-cyan-300">
                        0x{telemetry.createPoolIxHex}
                      </span>
                      {telemetry.lastSwapIxHex && (
                        <>
                          {' '}
                          | swap (18B):{' '}
                          <span className="text-emerald-300">
                            0x{telemetry.lastSwapIxHex}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Fee Creator — 0.06% dari setiap swap (LP 0.24%) */}
                <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] text-zinc-400">
                      <span className="font-semibold text-amber-300">Fee Creator</span>{' '}
                      0.06% per swap &bull; terakumulasi di{' '}
                      <code className="text-zinc-300">fee_vault_x/y</code>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleClaimCreatorFee()}
                      disabled={
                        claimBusy ||
                        !poolInfo ||
                        (poolInfo.creatorFeeX === 0n && poolInfo.creatorFeeY === 0n)
                      }
                      className="rounded-md border border-amber-500/50 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {claimBusy ? 'Mengklaim…' : 'Claim Fee'}
                    </button>
                  </div>
                  <div className="mt-2 grid gap-1 font-mono text-[11px] text-zinc-300">
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-500">Siap diklaim X (SOL):</span>
                      <span className="text-emerald-300">
                        {formatTokenAmount(poolInfo.creatorFeeX, 9, 6)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-500">
                        Siap diklaim Y ({ticker.toUpperCase()}):
                      </span>
                      <span className="text-emerald-300">
                        {formatTokenAmount(poolInfo.creatorFeeY, 9, 6)}
                      </span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-zinc-500">creator:</span>
                      <span className="truncate text-zinc-400">
                        {shortenAddress(poolInfo.creator.toBase58(), 6)}
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-[10px] text-zinc-500">
                    CLI: <code className="text-zinc-400">npm run claim:creator -- --pool{' '}
                    {shortenAddress(poolInfo.poolAddress.toBase58(), 6)}</code>
                  </p>
                </div>
              </div>

              {/* Swap Terminal (`transfer_checked`) */}
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-zinc-100">
                    2. Swap Terminal (<code className="text-emerald-400">transfer_checked</code>, 0.3% Fee)
                  </h3>
                  <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setTradeSide('BUY');
                        setTradeAmountInput('5');
                      }}
                      className={`rounded-md px-3 py-1 font-semibold transition ${
                        tradeSide === 'BUY'
                          ? 'bg-emerald-500 text-zinc-950'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      Beli (SOL &rarr; {ticker.toUpperCase()})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTradeSide('SELL');
                        setTradeAmountInput('10000000');
                      }}
                      className={`rounded-md px-3 py-1 font-semibold transition ${
                        tradeSide === 'SELL'
                          ? 'bg-rose-500 text-zinc-950'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      Jual ({ticker.toUpperCase()} &rarr; SOL)
                    </button>
                  </div>
                </div>

                <div className="grid items-end gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs text-zinc-400">
                      Jumlah Input (
                      {tradeSide === 'BUY' ? 'SOL' : ticker.toUpperCase()})
                    </label>
                    <input
                      type="text"
                      value={tradeAmountInput}
                      onChange={(e) => setTradeAmountInput(e.target.value)}
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
                    <div className="text-[11px] text-zinc-400">
                      Output Estimasi (Virtual + Real Curve)
                    </div>
                    <div className="font-mono text-sm font-semibold text-emerald-400">
                      {swapQuote
                        ? `${formatTokenAmount(
                            swapQuote.amountOut,
                            9,
                            4
                          )} ${tradeSide === 'BUY' ? ticker.toUpperCase() : 'SOL'}`
                        : '—'}
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!swapQuote || isBusy}
                  onClick={handleExecuteSwap}
                  className={`mt-3 w-full rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-50 ${
                    tradeSide === 'BUY'
                      ? 'bg-emerald-500 text-zinc-950 hover:bg-emerald-400'
                      : 'bg-rose-500 text-zinc-950 hover:bg-rose-400'
                  }`}
                >
                  {stage === 'SWAPPING'
                    ? 'Memproses transfer_checked Swap...'
                    : tradeSide === 'BUY'
                      ? `Beli $${ticker.toUpperCase()} (Token-2022)`
                      : `Jual $${ticker.toUpperCase()} ke SOL`}
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-center">
              <p className="font-mono text-xs text-zinc-400">
                Klik <strong>Launch Token-2022 &amp; Virtual Pool</strong> untuk
                membuat Mint Token-2022 dengan ekstensi{' '}
                <code className="text-zinc-200">MetadataPointer</code> +{' '}
                <code className="text-zinc-200">TokenMetadata</code> dan
                menginisialisasi Virtual Liquidity AMM.
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
