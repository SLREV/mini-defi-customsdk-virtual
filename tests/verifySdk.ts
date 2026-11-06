import assert from 'node:assert/strict';
import {
  AccountInfo,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import {
  ADD_LIQUIDITY_IX_LAYOUT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLAIM_CREATOR_FEE_IX_LAYOUT,
  CREATE_POOL_IX_LAYOUT,
  CustomDefiSDK,
  DEFAULT_AMM_PROGRAM_ID,
  DEFAULT_VIRTUAL_SOL_LAMPORTS,
  NATIVE_SOL_MINT,
  POOL_STATE_DISCRIMINATOR,
  POOL_STATE_SIZE,
  PoolStateLayout,
  SPL_MINT_ACCOUNT_LAYOUT,
  SPL_MINT_SIZE,
  SPL_TOKEN_ACCOUNT_LAYOUT,
  SPL_TOKEN_ACCOUNT_SIZE,
  SWAP_IX_LAYOUT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_METADATA_INITIALIZE_DISCRIMINATOR,
  TOKEN_METADATA_UPDATE_FIELD_DISCRIMINATOR,
  TOKEN_PROGRAM_ID,
  calculateCreatorFee,
  calculateInitialLpTokens,
  calculateSwapOutput,
  calculateToken2022MintTotalBytes,
  formatTokenAmount,
  integerSqrtBigInt,
  parseTokenAmount,
  toU64BigInt,
} from '../src/sdk/customSdk';

class MockConnection extends Connection {
  public readonly ledger = new Map<string, AccountInfo<Buffer>>();

  constructor() {
    super('http://127.0.0.1:8899', 'confirmed');
  }

  override async getMinimumBalanceForRentExemption(size: number): Promise<number> {
    return (128 + size) * 6960;
  }

  override async getLatestBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1000,
    };
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
}

async function main(): Promise<void> {
  const conn = new MockConnection();
  const sdk = new CustomDefiSDK(conn, DEFAULT_AMM_PROGRAM_ID);
  const payer = Keypair.generate();

  // 1. Verifikasi ukuran PoolStateLayout = 281 bytes (PoolState v2 + fee creator)
  assert.equal(PoolStateLayout.span, 281);
  assert.equal(POOL_STATE_SIZE, 281);

  // 2. Uji presisi 9 desimal BigInt (1 Milyar Token-2022 = 10^18 > MAX_SAFE_INTEGER)
  const supplyRaw = parseTokenAmount('1000000000', 9);
  assert.equal(supplyRaw, 1_000_000_000_000_000_000n);

  // 3. Uji Clone Token-2022 + Native MetadataPointer + TokenMetadata + UpdateField (Telegram & Twitter)
  const clone = await sdk.buildCloneTokenInstructions({
    payer: payer.publicKey,
    name: 'Nusantara Token 2022',
    symbol: 'NUSA',
    imageUri:
      'https://ipfs.io/ipfs/bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy',
    telegram: 'https://t.me/nusa_2022',
    twitter: 'https://x.com/nusa_2022',
    decimals: 9,
    initialSupplyRaw: supplyRaw,
    tokenStandard: 'TOKEN_2022',
  });

  assert.equal(clone.tokenProgramId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(clone.metadataAddress.toBase58(), clone.mint.toBase58());
  // 8 instruksi: CreateAccount(234B) + InitMetadataPointer(39,0) + InitMint2(20) + InitMetadata + UpdateField(tg) + UpdateField(tw) + CreateATA + MintToChecked(14)
  assert.equal(clone.instructions.length, 8);
  assert.equal(clone.instructions[1].data.byteLength, 66);
  assert.equal(clone.instructions[1].data[0], 39); // MetadataPointerExtension
  assert.equal(clone.instructions[2].data.byteLength, 67);
  assert.equal(clone.instructions[2].data[0], 20); // InitializeMint2
  assert.deepEqual(
    Array.from(clone.instructions[3].data.subarray(0, 8)),
    Array.from(TOKEN_METADATA_INITIALIZE_DISCRIMINATOR)
  );
  assert.deepEqual(
    Array.from(clone.instructions[4].data.subarray(0, 8)),
    Array.from(TOKEN_METADATA_UPDATE_FIELD_DISCRIMINATOR)
  );
  assert.equal(clone.instructions[7].data.byteLength, 10);
  assert.equal(clone.instructions[7].data[0], 14); // MintToChecked

  // 3a-1. REGRESI MintToChecked: layout WAJIB 3 akun [mint, destination, mintAuthority].
  // Versi lama menyisipkan `mint` kedua di indeks 1 (layout `TransferChecked`), sehingga
  // Token-2022 membaca akun Mint sebagai `destination` dan transaksi gagal dengan
  // "Error: UninitializedAccount / instruction requires an initialized account".
  const mintToIx = clone.instructions[7];
  assert.equal(mintToIx.keys.length, 3, 'MintToChecked harus 3 AccountMeta');
  assert.equal(mintToIx.programId.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(mintToIx.keys[0].pubkey.toBase58(), clone.mint.toBase58());
  assert.equal(mintToIx.keys[0].isWritable, true);
  assert.equal(mintToIx.keys[1].pubkey.toBase58(), clone.userTokenAta.toBase58());
  assert.equal(mintToIx.keys[1].isWritable, true);
  assert.equal(mintToIx.keys[2].pubkey.toBase58(), payer.publicKey.toBase58());
  assert.equal(mintToIx.keys[2].isSigner, true);
  // `destination` MintToChecked harus ATA yang dibuat instruksi tepat sebelumnya
  assert.equal(clone.instructions[6].data[0], 1); // CreateIdempotent
  assert.equal(
    clone.instructions[6].keys[1].pubkey.toBase58(),
    mintToIx.keys[1].pubkey.toBase58(),
    'ATA yang dibuat harus sama dengan destination MintToChecked'
  );
  // mint tidak boleh muncul dua kali di dalam satu instruksi
  assert.equal(
    new Set(mintToIx.keys.map((k) => k.pubkey.toBase58())).size,
    mintToIx.keys.length
  );
  // Tanpa metadataUri, `uri` on-chain memakai URL gambar
  assert.equal(clone.resolvedMetadataUri, clone.offchainMetadataJson.image);

  // 3b. metadataUri (hasil `npm run pinata:upload`): `uri` on-chain -> JSON metadata,
  //     sedangkan `image` di dalam JSON tetap URL gambar.
  const metadataJsonUri =
    'https://nusantara-gateway.mypinata.cloud/ipfs/QmMetadataHashUji1234567890abcdefghijklmnopqrstuvwxyz';
  const cloneWithJson = await sdk.buildCloneTokenInstructions({
    payer: payer.publicKey,
    name: 'Nusantara Token 2022',
    symbol: 'NUSA',
    imageUri: clone.offchainMetadataJson.image,
    metadataUri: metadataJsonUri,
    telegram: 'https://t.me/nusa_2022',
    twitter: 'https://x.com/nusa_2022',
    decimals: 9,
    initialSupplyRaw: supplyRaw,
    tokenStandard: 'TOKEN_2022',
  });
  assert.equal(cloneWithJson.resolvedMetadataUri, metadataJsonUri);
  assert.equal(cloneWithJson.offchainMetadataJson.image, clone.offchainMetadataJson.image);
  // instruksi TokenMetadata::Initialize memuatan uri JSON, bukan URL gambar
  assert.ok(
    cloneWithJson.instructions[3].data.includes(Buffer.from(metadataJsonUri, 'utf8')),
    'uri JSON harus tertanam pada instruksi initialize metadata'
  );
  // ukuran akun mint mengikuti uri yang lebih panjang (agar realloc tidak gagal)
  assert.equal(
    cloneWithJson.allocatedMintBytes,
    calculateToken2022MintTotalBytes({
      name: 'Nusantara Token 2022',
      symbol: 'NUSA',
      uri: metadataJsonUri,
      additionalMetadata: cloneWithJson.additionalMetadata,
    })
  );
  assert.ok(cloneWithJson.allocatedMintBytes > clone.allocatedMintBytes);

  // 3c. Mode kompatibilitas SPL Legacy: instruksi MintToChecked tetap 3 akun,
  //     hanya program pemiliknya yang berbeda (Tokenkeg…).
  const cloneLegacy = await sdk.buildCloneTokenInstructions({
    payer: payer.publicKey,
    name: 'Nusantara Legacy',
    symbol: 'NUSA',
    imageUri: clone.offchainMetadataJson.image,
    decimals: 9,
    initialSupplyRaw: supplyRaw,
    tokenStandard: 'SPL_LEGACY',
  });
  const legacyMintToIx =
    cloneLegacy.instructions[cloneLegacy.instructions.length - 1];
  assert.equal(legacyMintToIx.data[0], 14); // MintToChecked
  assert.equal(legacyMintToIx.keys.length, 3);
  assert.equal(legacyMintToIx.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(legacyMintToIx.keys[1].pubkey.toBase58(), cloneLegacy.userTokenAta.toBase58());

  // 4. Uji buildCreatePoolTx (Discriminator 0, 17B payload, 15 AccountMeta lintas TokenProgram)
  const createPool = await sdk.buildCreatePoolTx({
    payer: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    initialRealTokenY: supplyRaw,
    virtualReservesX: DEFAULT_VIRTUAL_SOL_LAMPORTS,
    tokenProgramX: TOKEN_PROGRAM_ID,
    tokenProgramY: TOKEN_2022_PROGRAM_ID,
    tokenProgramLp: TOKEN_2022_PROGRAM_ID,
  });

  assert.equal(createPool.serializedIxData.byteLength, 17);
  assert.equal(createPool.instruction.keys.length, 17);
  // Pastikan token_program_x = SPL Legacy (WSOL) & token_program_y = Token-2022
  // fee vault creator di indeks 7 & 8 (setelah vault_x / vault_y)
  assert.equal(
    createPool.instruction.keys[7].pubkey.toBase58(),
    createPool.addresses.feeVaultX.toBase58()
  );
  assert.equal(
    createPool.instruction.keys[8].pubkey.toBase58(),
    createPool.addresses.feeVaultY.toBase58()
  );
  assert.equal(
    createPool.instruction.keys[11].pubkey.toBase58(),
    TOKEN_PROGRAM_ID.toBase58()
  );
  assert.equal(
    createPool.instruction.keys[12].pubkey.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58()
  );

  const decodedCreate = CREATE_POOL_IX_LAYOUT.decode(createPool.serializedIxData);
  assert.equal(decodedCreate.discriminator, 0);
  assert.equal(decodedCreate.initialRealTokenY, supplyRaw);
  assert.equal(decodedCreate.virtualReservesX, 30_000_000_000n);

  // Transaksi pool = CreateIdempotent ATA token Y + initialize_pool
  assert.equal(createPool.transaction.instructions.length, 2);
  assert.equal(
    createPool.transaction.instructions[0].programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
  );
  assert.equal(
    createPool.transaction.instructions[0].keys[3].pubkey.toBase58(),
    clone.mint.toBase58()
  );
  // Suplai LP awal = sqrt(virtualReservesX * initialRealTokenY)
  assert.equal(
    createPool.expectedInitialLp,
    integerSqrtBigInt(DEFAULT_VIRTUAL_SOL_LAMPORTS * supplyRaw)
  );

  createPool.transaction.sign(payer);
  assert.ok(createPool.transaction.serialize().byteLength <= 1232);

  // 5. Uji buildAddLiquidityTx (Discriminator 1, 25B, 13 AccountMeta)
  const addLiq = await sdk.buildAddLiquidityTx({
    user: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    amountX: 5_000_000_000n,
    amountY: 100_000_000_000_000_000n,
    minLpOut: 100n,
  });
  assert.equal(addLiq.serializedIxData.byteLength, 25);
  assert.equal(addLiq.instruction.keys.length, 13);
  assert.equal(
    ADD_LIQUIDITY_IX_LAYOUT.decode(addLiq.serializedIxData).discriminator,
    1
  );
  // 3 ATA idempotent + transfer SOL + SyncNative + add_liquidity
  assert.equal(addLiq.transaction.instructions.length, 6);
  addLiq.transaction.sign(payer);
  assert.ok(addLiq.transaction.serialize().byteLength <= 1232);

  // 6. Uji buildSwapTx (Discriminator 2, 18B, 10 AccountMeta)
  const swapBuild = await sdk.buildSwapTx({
    user: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    amountIn: 5_000_000_000n,
    minAmountOut: 1n,
    xToY: true,
  });
  assert.equal(swapBuild.serializedIxData.byteLength, 18);
  assert.equal(swapBuild.instruction.keys.length, 12);
  // fee vault creator ikut dikirim di indeks 6 & 7 (setelah vault_x / vault_y)
  assert.equal(
    swapBuild.instruction.keys[6].pubkey.toBase58(),
    swapBuild.addresses.feeVaultX.toBase58()
  );
  assert.equal(
    swapBuild.instruction.keys[7].pubkey.toBase58(),
    swapBuild.addresses.feeVaultY.toBase58()
  );
  assert.equal(swapBuild.instruction.keys[6].isWritable, true);
  assert.equal(swapBuild.instruction.keys[7].isWritable, true);
  assert.equal(SWAP_IX_LAYOUT.decode(swapBuild.serializedIxData).discriminator, 2);
  // 2 ATA idempotent + transfer SOL + SyncNative + swap
  assert.equal(swapBuild.transaction.instructions.length, 5);
  assert.equal(
    SWAP_IX_LAYOUT.decode(swapBuild.serializedIxData).xToY,
    1
  );
  swapBuild.transaction.sign(payer);
  assert.ok(swapBuild.transaction.serialize().byteLength <= 1232);

  // Swap arah sebaliknya (Token Y -> SOL): tanpa transfer/SyncNative, tetapi
  // diakhiri CloseAccount agar WSOL dicairkan menjadi SOL native (unwrap).
  const sellBuild = await sdk.buildSwapTx({
    user: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    amountIn: 1_000_000_000n,
    minAmountOut: 0n,
    xToY: false,
  });
  assert.equal(sellBuild.transaction.instructions.length, 4);
  assert.equal(SWAP_IX_LAYOUT.decode(sellBuild.serializedIxData).xToY, 0);
  assert.equal(sellBuild.unwrapWsol, true);
  const closeIx = sellBuild.transaction.instructions[3];
  assert.equal(closeIx.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.deepEqual(Array.from(closeIx.data), [9]); // CloseAccount
  assert.equal(
    closeIx.keys[0].pubkey.toBase58(),
    sellBuild.transaction.instructions[0].keys[1].pubkey.toBase58() // ATA WSOL
  );
  sellBuild.transaction.sign(payer);
  assert.ok(sellBuild.transaction.serialize().byteLength <= 1232);

  // Opsi unwrap bisa dimatikan (mis. bila pengguna ingin menyimpan WSOL)
  const sellNoUnwrap = await sdk.buildSwapTx({
    user: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    amountIn: 1_000_000_000n,
    xToY: false,
    unwrapWsol: false,
  });
  assert.equal(sellNoUnwrap.transaction.instructions.length, 3);
  assert.equal(sellNoUnwrap.unwrapWsol, false);

  // unwrapWsol tidak valid untuk arah beli
  await assert.rejects(() =>
    sdk.buildSwapTx({
      user: payer.publicKey,
      tokenX: NATIVE_SOL_MINT,
      tokenY: clone.mint,
      amountIn: 1_000_000_000n,
      xToY: true,
      unwrapWsol: true,
    })
  );

  // 7. Uji fetchPoolInfo() Deserialisasi Biner 281B + Vault Token-2022 + Fee Vault
  const initialLp = calculateInitialLpTokens(DEFAULT_VIRTUAL_SOL_LAMPORTS, supplyRaw);
  // Cadangan efektif = vault.amount + virtual_reserves, dengan virtual_reserves_y = 0.
  const swapOut5Sol = calculateSwapOutput(
    5_000_000_000n,
    DEFAULT_VIRTUAL_SOL_LAMPORTS,
    supplyRaw
  );

  const poolBuf = Buffer.alloc(POOL_STATE_SIZE);
  PoolStateLayout.encode(
    {
      discriminator: POOL_STATE_DISCRIMINATOR,
      tokenX: NATIVE_SOL_MINT,
      tokenY: clone.mint,
      vaultX: createPool.addresses.vaultX,
      vaultY: createPool.addresses.vaultY,
      lpMint: createPool.addresses.lpMint,
      creator: payer.publicKey,
      feeVaultX: createPool.addresses.feeVaultX,
      feeVaultY: createPool.addresses.feeVaultY,
      virtualReservesX: DEFAULT_VIRTUAL_SOL_LAMPORTS,
      virtualReservesY: 0n,
      bump: createPool.addresses.poolBump,
    },
    poolBuf
  );
  conn.ledger.set(createPool.addresses.poolState.toBase58(), {
    data: poolBuf,
    executable: false,
    lamports: 2_150_000,
    owner: DEFAULT_AMM_PROGRAM_ID,
    rentEpoch: 0,
  });

  const vaultXBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
  SPL_TOKEN_ACCOUNT_LAYOUT.encode(
    {
      mint: NATIVE_SOL_MINT,
      owner: createPool.addresses.poolState,
      amount: 5_000_000_000n,
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
  conn.ledger.set(createPool.addresses.vaultX.toBase58(), {
    data: vaultXBuf,
    executable: false,
    lamports: 7_039_280,
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
  });

  const vaultYBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
  SPL_TOKEN_ACCOUNT_LAYOUT.encode(
    {
      mint: clone.mint,
      owner: createPool.addresses.poolState,
      amount: supplyRaw - swapOut5Sol,
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
  conn.ledger.set(createPool.addresses.vaultY.toBase58(), {
    data: vaultYBuf,
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_2022_PROGRAM_ID,
    rentEpoch: 0,
  });

  const lpMintBuf = Buffer.alloc(SPL_MINT_SIZE);
  SPL_MINT_ACCOUNT_LAYOUT.encode(
    {
      mintAuthorityOption: 1,
      mintAuthority: createPool.addresses.poolState,
      supply: initialLp,
      decimals: 9,
      isInitialized: 1,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    lpMintBuf
  );
  conn.ledger.set(createPool.addresses.lpMint.toBase58(), {
    data: lpMintBuf,
    executable: false,
    lamports: 1_461_600,
    owner: TOKEN_2022_PROGRAM_ID,
    rentEpoch: 0,
  });

  // Fee vault creator (hasil akumulasi 0.06% dari swap 5 SOL di atas)
  const accruedCreatorFeeX = calculateCreatorFee(5_000_000_000n);
  const feeVaultXBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
  SPL_TOKEN_ACCOUNT_LAYOUT.encode(
    {
      mint: NATIVE_SOL_MINT,
      owner: createPool.addresses.poolState,
      amount: accruedCreatorFeeX,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 1,
      isNative: 2_039_280n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    feeVaultXBuf
  );
  conn.ledger.set(createPool.addresses.feeVaultX.toBase58(), {
    data: feeVaultXBuf,
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM_ID,
    rentEpoch: 0,
  });

  const feeVaultYBuf = Buffer.alloc(SPL_TOKEN_ACCOUNT_SIZE);
  SPL_TOKEN_ACCOUNT_LAYOUT.encode(
    {
      mint: clone.mint,
      owner: createPool.addresses.poolState,
      amount: 0n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    feeVaultYBuf
  );
  conn.ledger.set(createPool.addresses.feeVaultY.toBase58(), {
    data: feeVaultYBuf,
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_2022_PROGRAM_ID,
    rentEpoch: 0,
  });

  const unpacked = await sdk.fetchPoolInfo(NATIVE_SOL_MINT, clone.mint);
  assert.equal(unpacked.tokenX.toBase58(), NATIVE_SOL_MINT.toBase58());
  assert.equal(unpacked.tokenY.toBase58(), clone.mint.toBase58());
  assert.equal(unpacked.tokenProgramX.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(unpacked.tokenProgramY.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  assert.equal(unpacked.realReservesX, 5_000_000_000n);
  assert.equal(unpacked.virtualReservesX, 30_000_000_000n);
  assert.equal(unpacked.totalReservesX, 35_000_000_000n);
  assert.equal(unpacked.virtualReservesY, 0n);
  assert.equal(unpacked.totalReservesY, supplyRaw - swapOut5Sol);
  assert.equal(unpacked.lpSupply, initialLp);
  // PoolState v2: creator + fee vault + akumulasi fee creator
  assert.equal(unpacked.creator.toBase58(), payer.publicKey.toBase58());
  assert.equal(
    unpacked.feeVaultX.toBase58(),
    createPool.addresses.feeVaultX.toBase58()
  );
  assert.equal(
    unpacked.feeVaultY.toBase58(),
    createPool.addresses.feeVaultY.toBase58()
  );
  assert.equal(unpacked.creatorFeeX, accruedCreatorFeeX);
  assert.equal(unpacked.creatorFeeY, 0n);

  // 8. Uji batas/edge-case matematika & parser (anti-regresi)
  assert.equal(integerSqrtBigInt(0n), 0n);
  assert.equal(integerSqrtBigInt(1n), 1n);
  assert.equal(integerSqrtBigInt(1_000_000_000_000_000_000n), 1_000_000_000n);
  assert.equal(toU64BigInt(42), 42n);
  assert.throws(() => toU64BigInt(-1));
  assert.throws(() => toU64BigInt(1.5));
  assert.throws(() => parseTokenAmount('1.1234567890', 9));
  assert.throws(() => parseTokenAmount('abc'));
  assert.throws(() => calculateSwapOutput(0n, 1n, 1n));
  assert.throws(() => calculateSwapOutput(1n, 0n, 1n));
  assert.throws(() => calculateInitialLpTokens(0n, 1n));
  assert.equal(formatTokenAmount(1_500_000_000n, 9, 2), '1.5');
  assert.equal(parseTokenAmount('1,000.5', 9), 1_000_500_000_000n);

  // 9. Fee creator (0.06%) + transaksi claim_creator_fee (disc 3, payload 10B)
  //    Total 30 bps = 24 bps LP + 6 bps creator.
  assert.equal(calculateCreatorFee(10_000n), 6n); // 6 bps
  assert.equal(calculateCreatorFee(0n), 0n);
  assert.equal(calculateCreatorFee(1_000_000_000n), 600_000n); // 0.06% dari 1 SOL
  // Fee creator tidak boleh "memakan" output lebih dari 0.06%:
  const outNoCreator = (5_000_000_000n * 9970n * supplyRaw) /
    (DEFAULT_VIRTUAL_SOL_LAMPORTS * 10_000n + 5_000_000_000n * 9970n);
  const totalFeeBiteBps =
    ((outNoCreator - swapOut5Sol) * 10_000n) / outNoCreator;
  assert.ok(
    totalFeeBiteBps <= 1n,
    `split fee creator mengubah output > 1 bps (${totalFeeBiteBps})`
  );

  const claim = await sdk.buildClaimCreatorFeeTx({
    creator: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
  });
  assert.equal(claim.serializedIxData.byteLength, 10);
  assert.equal(CLAIM_CREATOR_FEE_IX_LAYOUT.span, 10);
  assert.equal(claim.instruction.data[0], 3); // discriminator claim_creator_fee
  assert.equal(claim.instruction.programId.toBase58(), DEFAULT_AMM_PROGRAM_ID.toBase58());
  assert.equal(claim.instruction.keys.length, 10);
  assert.equal(
    CLAIM_CREATOR_FEE_IX_LAYOUT.decode(claim.serializedIxData).side,
    0
  );
  assert.equal(CLAIM_CREATOR_FEE_IX_LAYOUT.decode(claim.serializedIxData).minAmount, 0n);

  // urutan akun: creator, pool_state, token_x, token_y, fee_vault_x, fee_vault_y,
  //              creator_token_x, creator_token_y, token_program_x, token_program_y
  assert.equal(claim.instruction.keys[0].pubkey.toBase58(), payer.publicKey.toBase58());
  assert.equal(claim.instruction.keys[0].isSigner, true);
  assert.equal(
    claim.instruction.keys[1].pubkey.toBase58(),
    claim.addresses.poolState.toBase58()
  );
  assert.equal(claim.instruction.keys[2].pubkey.toBase58(), NATIVE_SOL_MINT.toBase58());
  assert.equal(claim.instruction.keys[3].pubkey.toBase58(), clone.mint.toBase58());
  assert.equal(
    claim.instruction.keys[4].pubkey.toBase58(),
    createPool.addresses.feeVaultX.toBase58()
  );
  assert.equal(
    claim.instruction.keys[5].pubkey.toBase58(),
    createPool.addresses.feeVaultY.toBase58()
  );
  assert.equal(
    claim.instruction.keys[6].pubkey.toBase58(),
    claim.creatorTokenX.toBase58()
  );
  assert.equal(
    claim.instruction.keys[7].pubkey.toBase58(),
    claim.creatorTokenY.toBase58()
  );
  assert.equal(claim.instruction.keys[8].pubkey.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(claim.instruction.keys[9].pubkey.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());
  // 2 CreateIdempotent (ATA creator X & Y) + claim
  assert.equal(claim.transaction.instructions.length, 3);
  assert.equal(
    claim.transaction.instructions[0].programId.toBase58(),
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()
  );
  assert.equal(claim.transaction.feePayer?.toBase58(), payer.publicKey.toBase58());
  claim.transaction.sign(payer);
  assert.ok(claim.transaction.serialize().byteLength <= 1232);

  // Sisi & batas minimal ikut ter-encode dengan benar
  const claimY = await sdk.buildClaimCreatorFeeTx({
    creator: payer.publicKey,
    tokenX: NATIVE_SOL_MINT,
    tokenY: clone.mint,
    side: 'Y',
    minAmount: 123_456n,
    createMissingAtas: false,
  });
  const decodedClaimY = CLAIM_CREATOR_FEE_IX_LAYOUT.decode(claimY.serializedIxData);
  assert.equal(decodedClaimY.side, 2);
  assert.equal(decodedClaimY.minAmount, 123_456n);
  assert.equal(claimY.transaction.instructions.length, 1); // tanpa ATA idempotent

  console.log('ALL TOKEN-2022 & VIRTUAL LIQUIDITY AMM BINARY TESTS PASSED!');
  console.log({
    token2022Mint: clone.mint.toBase58(),
    allocatedMintBytes: clone.allocatedMintBytes,
    poolPda: unpacked.poolAddress.toBase58(),
    totalEffectiveSol: formatTokenAmount(unpacked.totalReservesX, 9, 2) + ' SOL',
    remainingVaultToken2022: formatTokenAmount(unpacked.realReservesY, 9, 2),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
