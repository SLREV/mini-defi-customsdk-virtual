# Solana Token-2022 Launchpad & Virtual Liquidity AMM (`TokenInterface` + `TransferChecked`)

Production-ready boilerplate untuk **DeFi Token-2022 Launchpad & Virtual Liquidity Constant Product AMM** menggunakan **Anchor 0.31+ (Rust)** + **Pure `@solana/web3.js` & `@solana/buffer-layout` (TypeScript)** + **Vite + React + TailwindCSS** — **tanpa SDK pihak ketiga**.

## Keunggulan Arsitektur Token-2022 & Virtual Liquidity

1. **Native Token-2022 Extensions (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`)**:
   - Menginisialisasi `MetadataPointer` (`u8(39), u8(0)`) menunjuk langsung ke akun Mint itu sendiri (*self-referential metadata*).
   - Menyimpan `name`, `symbol`, dan `uri` via `spl_token_metadata_interface::initialize` serta menyimpan link sosial (`telegram`, `twitter`) **100% on-chain di dalam TLV Mint Token-2022** via `updating_field`!
   - Akun Mint didanai penuh untuk ukuran akhir (`234B + 4B TLV header + payload TokenMetadata`) **sebelum** `initialize` metadata dipanggil, sehingga proses realloc internal Token-2022 tidak gagal karena `InsufficientFundsForRent`.
2. **Hybrid Multi-Program `TokenInterface` (`token_program_x`, `token_program_y`, `token_program_lp`)**:
   - Memungkinkan pasangan lintas-program antara **WSOL (`Tokenkeg...` SPL Legacy)** dan **Token Proyek Baru (`TokenzQd...` Token-2022)** menggunakan `token_interface::transfer_checked`!
3. **Virtual Liquidity Sejak Detik ke-0**:
   - Kreator menyetor 100% token fisik ke `vault_y` tanpa perlu menyetor modal SOL awal (`vault_x.amount = 0`, `virtual_reserves_x = 30 SOL`).
   - Kurva AMM memakai **cadangan efektif** `vault.amount + virtual_reserves` yang dibaca langsung dari saldo vault on-chain (aman terhadap ekstensi `TransferFee` Token-2022).
   - **`virtual_reserves_y = 0` pada inisialisasi**: seluruh suplai token Y sudah berada di `vault_y`, sehingga token Y tidak dihitung dua kali. Dengan demikian `LP_awal = sqrt(virtual_reserves_x × initial_real_token_y) = sqrt(k_efektif)` konsisten dengan invariant `x · y = k`.

## Spesifikasi Biner (`@solana/buffer-layout`)

| Instruksi / Akun | Discriminator | Ukuran | Layout Biner |
| :--- | :--- | :--- | :--- |
| `Token-2022 MetadataPointer::Init` | `[39, 0]` | `66 B` | `[u8(39), u8(0), Pubkey(authority), Pubkey(metadataAddress)]` |
| `Token-2022 InitializeMint2` | `u8 = 20` | `67 B` | `[u8(20), u8(decimals), Pubkey(mintAuth), u8(freezeOpt), Pubkey(freezeAuth)]` |
| `Token-2022 TokenMetadata::Initialize` | `sha256[..8]` | Variabel | `8B disc + BorshString(name) + BorshString(symbol) + BorshString(uri)` |
| `Token-2022 TokenMetadata::UpdateField` | `sha256[..8]` | Variabel | `8B disc + u8(3 = Field::Key) + BorshString(key) + BorshString(value)` |
| `Token-2022 MintToChecked` | `u8 = 14` | `10 B` | `[u8(14), u64_le(amount), u8(decimals)]` — akun: **3** = `[mint (w), destination ATA (w), mint_authority (s)]` |
| `AMM initialize_pool` | `u8 = 0` | `17 B` | `[u8(0), u64_le(initial_real_token_y), u64_le(virtual_reserves_x)]` |
| `AMM add_liquidity` | `u8 = 1` | `25 B` | `[u8(1), u64_le(amount_x), u64_le(amount_y), u64_le(min_lp_out)]` |
| `AMM swap` | `u8 = 2` | `18 B` | `[u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]` |
| `AMM claim_creator_fee` | `u8 = 3` | `10 B` | `[u8(3), u8(side), u64_le(min_amount)]` — `side`: `0`=kedua sisi, `1`=X, `2`=Y |
| `Account: PoolState` | `sha256("account:PoolState")[..8]` | `281 B` | `8B disc + 8*32B Pubkey (mint/vault/lp/creator/fee_vault_x/fee_vault_y) + 2*8B u64(virtualX, virtualY) + 1B bump` |

Anchor 0.31 mendukung **custom discriminator** 1 byte (`#[instruction(discriminator = [0])]`), sehingga payload instruksi AMM hanya 17/25/18/10 byte (bukan 24/32/25/17 byte) dan hemat ~21 byte per transaksi.

**Fee swap 0.30% dipecah dua:** `24 bps (0.24%)` untuk LP (tertinggal di `vault_x`/`vault_y`) + `6 bps (0.06%)` untuk **creator** pool (masuk `fee_vault_x`/`fee_vault_y`, diklaim lewat instruksi `claim_creator_fee`). Fee creator dipotong dari `amount_in` sebelum masuk vault, jadi cadangan vault dan invariant `k` tetap bersih.

### Jumlah `AccountMeta` per Instruksi

| Instruksi | Akun | Keterangan |
| :--- | :--- | :--- |
| `initialize_pool` | 17 | `payer`, `token_x`, `token_y`, `pool_state`, `lp_mint`, `vault_x`, `vault_y`, `fee_vault_x`, `fee_vault_y`, `user_token_y`, `user_lp_token`, 3× token program, ATA program, system program, rent |
| `add_liquidity` | 13 | `user`, 2 mint, `pool_state`, `lp_mint`, 2 vault, 3 user token account, 3 token program |
| `swap` | 12 | `user`, 2 mint, `pool_state`, 2 vault, `fee_vault_x`, `fee_vault_y`, 2 user token account, 2 token program |
| `claim_creator_fee` | 10 | `creator` (signer), `pool_state`, 2 mint, `fee_vault_x`, `fee_vault_y`, 2 ATA creator, 2 token program |

> `buildCreatePoolTx()` mengirim **2 instruksi** dalam satu transaksi: `CreateIdempotent` ATA token Y (wajib ada sebelum CPI `transfer_checked`) + `initialize_pool`. `buildAddLiquidityTx()` dan `buildSwapTx()` juga menyertakan pembuatan ATA idempotent (plus `SystemProgram.transfer` + `SyncNative` bila sisi input adalah WSOL).

## Struktur Proyek

```text
.
├── Anchor.toml                  # Konfigurasi Anchor (program mini_amm, devnet)
├── Cargo.toml                   # Workspace Rust (members = programs/*)
├── programs/
│   └── mini-amm/
│       ├── Cargo.toml
│       └── src/lib.rs           # Program AMM Token-2022 + Virtual Liquidity
├── src/
│   ├── App.tsx                  # Dashboard: launch token, pipeline, swap terminal
│   ├── main.tsx                 # Entry point Vite/React
│   ├── polyfills.ts             # Buffer polyfill (Browser)
│   ├── index.css                # Tailwind entry
│   └── sdk/customSdk.ts         # SDK biner murni (buffer-layout, tanpa SDK pihak ketiga)
├── tests/
│   ├── verifySdk.ts             # Uji layout biner, PDA, matematika AMM & deserialisasi
│   ├── verifyPinata.ts          # Uji upload Pinata (mock server, tanpa jaringan)
│   ├── verifyPinataApi.ts       # Uji dev API /api/pinata/* (mock server)
│   └── verifyClaimCreator.ts    # Uji CLI claim fee creator (mock RPC/ledger)
├── scripts/
│   ├── devnetPreflight.ts       # Cek kesiapan devnet (RPC, program, saldo)
│   ├── pinataUpload.ts          # CLI upload gambar + metadata JSON ke IPFS (Pinata)
│   ├── pinataDevApi.ts          # Dev API /api/pinata/* (Vite middleware, upload dari UI)
│   └── claimCreatorFee.ts       # CLI klaim fee creator 0.06% (dry-run/--execute)
├── index.html
├── tailwind.config.js           # content: index.html + src/**/*.{ts,tsx}
├── tsconfig.json                # include: src, tests
└── vite.config.ts
```

## Upload Gambar & Metadata ke IPFS via Pinata

Script otomatis `scripts/pinataUpload.ts` mengunggah **gambar token** lalu **JSON metadata**
ke IPFS, dan mengembalikan dua URL gateway yang dipakai di dashboard. Implementasinya memakai
REST API Pinata langsung (`fetch` + `FormData` bawaan Node) — **tanpa dependensi**, tanpa SDK
deprecated, dan tidak memerlukan `dotenv`.

```bash
# 1. Siapkan kredensial (ambil dari https://app.pinata.cloud/developers/api-keys)
cp .env.example .env
#   isi salah satu:
#   PINATA_JWT=...                     (disarankan)
#   atau PINATA_API_KEY=... + PINATA_API_SECRET=...

# 2. Verifikasi kredensial
npm run pinata:check

# 3. Validasi input tanpa upload (tidak perlu kredensial)
npm run pinata:upload -- --dry-run --image ./logo.png --name "Nusantara Token" --symbol NUSA

# 4. Upload sungguhan
npm run pinata:upload -- --image ./logo.png --name "Nusantara Token" --symbol NUSA \
    --telegram https://t.me/nusa --twitter https://x.com/nusa
```

Keluaran:

```
✓ Gambar terunggah (12.2 KB): https://gateway.pinata.cloud/ipfs/Qm...
✓ Metadata JSON terunggah: https://gateway.pinata.cloud/ipfs/Qm...

=== Hasil ===
imageUri    : https://gateway.pinata.cloud/ipfs/QmImage...
metadataUri : https://gateway.pinata.cloud/ipfs/QmMetadata...
```

Opsi lain: `--description`, `--website`, `--out <path>` (default `pinata-upload-result.json`,
sudah di-.gitignore), `--help`.

### Upload langsung dari dashboard (`npm run dev`)

Ada dua cara memakai Pinata. **Cara A** (di bawah) paling sederhana: satu perintah terminal.
**Cara B** ini membuat dashboard bisa upload sendiri lewat file picker.

```bash
cp .env.example .env      # isi PINATA_JWT (atau key/secret)
npm run dev               # log akan menampilkan: ✓ Pinata dev API aktif
```

Di dashboard, bagian **“Upload gambar ke IPFS (Pinata)”**:

1. Badge menunjukkan **PINATA SIAP** (hijau) bila kredensial terbaca, atau
   **BELUM DIKONFIGURASI** (kuning) beserta alasannya.
2. Pilih file gambar → gambar + JSON metadata diunggah otomatis.
3. Kolom **Image URI** dan **Metadata JSON URI** langsung terisi (`imageUri` / `metadataUri`).
4. Klik **Launch Token-2022 & Virtual Pool**.

Cara kerjanya: browser **tidak pernah** memegang secret. Ia memanggil endpoint di dev server
(`scripts/pinataDevApi.ts`, Vite middleware), lalu server membaca `PINATA_JWT` dari `.env` dan
meneruskan upload ke Pinata memakai pipeline yang sama dengan CLI.

| Endpoint (dev only) | Keterangan |
| :--- | :--- |
| `GET /api/pinata/status` | `{ configured, gateway, message }` — untuk badge di UI |
| `POST /api/pinata/upload` | body `{ fileName, base64, name, symbol, telegram?, twitter?, website?, description? }` → `{ imageUri, metadataUri, imageHash, metadataHash }` |

Kode status: `400` input tidak valid, `405` method salah, `413` body terlalu besar,
`502` Pinata menolak (mis. 401), `503` kredensial belum diset.

> **Batasan:** middleware ini hanya aktif di `npm run dev`. Hasil `npm run build`
> (`npm run preview`) **tidak** menyertakan `/api/pinata/*` — untuk produksi, pindahkan
> handler yang sama ke backend sungguhan (Express/serverless) dan simpan JWT sebagai
> environment variable server.

### Memakai hasilnya di dashboard

| Kolom di dashboard | Nilai yang ditempel |
| :--- | :--- |
| **Image URI** | `imageUri` (URL gambar) — dipakai sebagai `image` di dalam JSON |
| **Metadata JSON URI (opsional)** | `metadataUri` (URL JSON) — dipakai sebagai `uri` on-chain |

Jika kolom *Metadata JSON URI* diisi, `uri` on-chain Token-2022 menunjuk ke JSON metadata
(standar yang dibaca wallet/explorer), sementara `imageUri` tetap menjadi `image` di JSON.
Jika dikosongkan, `uri` on-chain memakai Image URI apa adanya (perilaku lama).

Catatan:

- **Jangan** menaruh secret Pinata dengan prefix `VITE_` (`VITE_PINATA_*`) — semua `VITE_*`
  ikut ter-bundle ke browser. Script ini hanya berjalan di Node/CLI.
- `cidVersion: 1` dipakai agar CID kompatibel dengan gateway modern.
- Gambar dibatasi 10 MB dan format `png/jpg/jpeg/gif/webp/svg` (validasi sebelum upload).
- Kalau memakai *dedicated gateway*, set `PINATA_GATEWAY=https://<nama>.mypinata.cloud`.

### Troubleshooting Pinata

| Gejala | Solusi |
| :--- | :--- |
| `Pinata API error 401` | API key/JWT salah atau sudah dicabut. Buat ulang di dashboard Pinata lalu `npm run pinata:check`. |
| `Pinata API error 403 (NO_SCOPES)` | API key tidak punya izin `pinFileToIPFS`/`pinJSONToIPFS` — aktifkan scope tersebut. |
| Upload lambat / timeout | Gateway publik sedang padat; coba lagi atau pakai dedicated gateway. |
| Metadata tidak tampil di wallet | Pastikan `uri` on-chain = `metadataUri` (JSON), bukan URL gambar langsung. |
| `Kredensial Pinata belum diset` | `.env` belum dibuat/terisi, atau dijalankan dari direktori yang salah. |

Uji otomatis (tanpa kredensial, memakai mock server lokal): `npm test` — menjalankan tiga
suite: layout biner AMM, CLI upload Pinata, dan dev API `/api/pinata/*`.

## Fee Creator (0.06%) & Cara Klaim

Setiap swap membebankan **0.30%**, dipecah otomatis di dalam program:

| Bagian | Porsi | Tujuan |
| :--- | :--- | :--- |
| LP | `24 bps` (0.24%) | tertinggal di `vault_x` / `vault_y` → memperbesar `k`, milik LP |
| **Creator** | `6 bps` (0.06%) | masuk `fee_vault_x` / `fee_vault_y` (PDA milik `pool_state`) |

Bagian creator **tidak** menyentuh cadangan vault, jadi harga/`k` tetap konsisten.
Akun `fee_vault_x`/`fee_vault_y` juga divalidasi lewat `has_one` di `swap` dan
`claim_creator_fee`, sehingga vault palsu ditolak dengan error `InvalidFeeVault`. Wallet yang
membuat pool (`initialize_pool` → `payer`) otomatis menjadi `creator` di `PoolState` dan
satu-satunya pihak yang boleh menarik fee tersebut.

### Klaim lewat CLI (disarankan)

```bash
# 1. Cek dulu tanpa mengirim transaksi (dry-run + simulasi preflight)
npm run claim:creator -- --pool <POOL_PDA>

# 2. Kirim sungguhan
npm run claim:creator -- --pool <POOL_PDA> --execute

# Opsi lain
npm run claim:creator -- --pool <POOL_PDA> --side y     # hanya sisi token Y
npm run claim:creator -- --pool <POOL_PDA> --min 0.001  # minimal 0.001 SOL terkumpul
npm run claim:creator -- --pool <POOL_PDA> --keypair ~/.config/solana/id.json
npm run claim:creator -- --pool <POOL_PDA> --rpc https://api.devnet.solana.com
```

Contoh keluaran:

```
RPC     : https://api.devnet.solana.com
Wallet  : 7xKX...9fQ

Pool    : 4MMLhXNXnyEtA5inVcHGLXBrYcVUsWn8ko5ai7PnDbZC
Creator : 7xKX...9fQ
Fee X   : 0.031500 SOL (WSOL)
Fee Y   : 0.087000 token
Sisi    : BOTH
Simulasi preflight: OK
Mode dry-run — tambahkan --execute untuk benar-benar mengirim transaksi.
```

Script akan: membaca `PoolState` (281 B) → memastikan wallet = `creator` → menampilkan saldo
`fee_vault_x`/`fee_vault_y` → menyusun transaksi `claim_creator_fee` (disc `3`, payload 10 B,
plus `CreateIdempotent` ATA creator) → simulasi preflight → (dengan `--execute`) kirim,
konfirmasi, lalu mencetak signature + tautan explorer.

### Klaim lewat dashboard

Panel pool menampilkan kartu **Fee Creator** berisi nominal siap klaim X (SOL) dan Y (token)
serta tombol **Claim Fee**. Tombol hanya aktif bila wallet aktif = `creator` pool.

### Syarat & error umum

- Program AMM harus sudah ter-deploy (`npm run devnet:check`) — kalau belum, transaksi akan
  ditolak dengan pesan "program belum ter-deploy".
- `Wallet ... bukan creator pool ini` → jalankan dengan keypair pembuat pool (`--keypair`).
- `Belum ada fee creator yang terakumulasi` → fee 0.06% baru terisi setelah ada swap.
- Di mode **Binary Sandbox**, tombol Claim hanya mengosongkan fee vault pada ledger lokal
  (tidak ada transaksi on-chain).

## Instal dari Nol di Linux (belum ada Node.js)

Node.js dari repo distro sering terlalu tua untuk Vite 6. Pakai **nvm** (tanpa sudo, tidak mengganggu paket sistem):

```bash
# 1. Prasyarat (biasanya sudah ada di Kali)
sudo apt update && sudo apt install -y curl git

# 2. Pasang nvm + Node.js 22 LTS
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm use 22

# 3. Cek versi (harus Node >= 18)
node -v   # v22.x
npm -v    # 10.x

# 4. Ambil proyek & pasang dependensi
git clone https://github.com/SLREV/mini-defi-customsdk.git
cd mini-defi-customsdk
npm install

# 5. Jalankan
npm run dev
```

Buka `http://localhost:5173`, biarkan mode **Binary Sandbox**, klik **Connect Mock Keypair**, lalu **Launch Token-2022 & Virtual Pool**.
Tidak perlu wallet, SOL, RPC, atau program ter-deploy — seluruh pipeline berjalan di ledger in-memory.

Cek kesehatan instalasi kapan saja:

```bash
npm test        # harus mencetak: ALL TOKEN-2022 & VIRTUAL LIQUIDITY AMM BINARY TESTS PASSED!
npm run build   # type-check ketat + build produksi ke dist/
```

> Jika Kali berjalan di VM/container dan browser ada di host, akses lewat `http://<IP-Kali>:5173`
> (server sudah bind ke `0.0.0.0`) dan buka port bila perlu: `sudo ufw allow 5173/tcp`.

## Perintah Menjalankan Proyek

```bash
npm install
npm test         # Uji seluruh layout biner Token-2022 & Virtual Liquidity AMM
npm run typecheck# Type-check ketat TypeScript (strict, noUnusedLocals)
npm run build    # Type-check + build produksi Vite (dist/)
npm run dev      # Dashboard interaktif di http://localhost:5173 (0.0.0.0)

npm run claim:creator -- --pool <POOL_PDA>   # Cek fee creator yang bisa diklaim (dry-run)

anchor build     # Build smart contract Rust (butuh Solana + Anchor CLI 0.31.1)
anchor deploy    # Deploy program mini_amm ke devnet
```

Mode **Binary Sandbox** di dashboard menjalankan seluruh pipeline (mint Token-2022 → inisialisasi pool → swap → deserialisasi 281B `PoolState`) terhadap ledger in-memory dengan serialisasi instruksi yang **sama persis** seperti transaksi on-chain; mode **Devnet RPC** mengirim transaksi sungguhan melalui wallet (Phantom atau keypair ephemeral).

## Menjalankan di Devnet (Checklist)

Mode **Devnet RPC** hanya bisa dipakai setelah 3 hal ini terpenuhi:

1. **Program ter-deploy** pada program ID yang sama dengan `declare_id!` (`Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp`) di cluster devnet.
2. **Wallet punya SOL devnet** (minimal ~0.1 SOL untuk fee + rent ATA/mint/pool).
3. **RPC dapat diakses dari browser** (endpoint publik `api.devnet.solana.com` bisa kena rate-limit).

```bash
# 0. Toolchain
#    Solana CLI + Anchor CLI 0.31.1 (avm install 0.31.1 && avm use 0.31.1)

# 1. Wallet provider
solana-keygen new -o ~/.config/solana/id.json   # jika belum punya
solana config set --url devnet

# 2. Pastikan program ID di Anchor.toml & declare_id! sinkron dengan keypair program
anchor keys sync

# 3. Build & deploy program ke devnet
anchor build
anchor deploy --provider.cluster devnet

# 4. Verifikasi kesiapan devnet (RPC, program executable, saldo wallet)
npm run devnet:check
npm run devnet:check -- --airdrop     # minta 1 SOL devnet bila saldo kurang

# 5. Jalankan dashboard, pilih mode "Devnet RPC"
npm run dev
```

Tips pemakaian di dashboard:

- Tanpa Phantom, klik **Connect Mock Keypair** lalu **Airdrop 1 SOL** (chip saldo di header menampilkan saldo `SOL` live).
- Saldo < `0.05 SOL` akan ditolak lebih awal dengan pesan jelas, bukan gagal di tengah pipeline.
- Transaksi mint Token-2022 dikirim dengan `ComputeBudgetProgram.setComputeUnitLimit` eksplisit (600k CU) karena alokasi + realloc TLV metadata bisa melewati default 200k CU.
- Setiap transaksi diverifikasi dengan `confirmTransaction` yang memakai blockhash **yang sama** dengan yang ditandatangani, dan `err` hasil konfirmasi selalu dicek — transaksi gagal tidak akan dilaporkan sukses.
- Saat menjual token, ATA WSOL ditutup (`CloseAccount`) sehingga Anda menerima **SOL native**, bukan WSOL.

### Memastikan versi kode yang berjalan

Header dashboard menampilkan stempel build, mis. `build 2026.11.06 · mintToChecked=3akun`.
Kalau stempel ini **tidak muncul** atau angkanya berbeda dari yang kamu harapkan, berarti
browser masih memakai bundle lama — bukan bug baru:

1. `git pull --ff-only` di folder proyek, lalu `git log --oneline -3` (harus ada commit perbaikan terbaru).
2. Restart `npm run dev`.
3. Hard reload browser (**Ctrl+Shift+R**). Kalau kamu memakai `npm run build` + `npm run preview`, jalankan `npm run build` ulang.

Cek cepat dari terminal bahwa layout `MintToChecked` sudah benar (harus **3** akun):

```bash
awk '/public buildMintToCheckedInstruction/,/^  \}$/' src/sdk/customSdk.ts \
  | grep -c "pubkey: mint,"
# hasil 1  -> layout baru  (3 akun: mint, destination ATA, mint_authority)
# hasil 2  -> layout lama   (4 akun -> UninitializedAccount di instruksi 8)
```

Selain itu dashboard mencetak ringkasan layout transaksi ke console (`console.table`):
`#8 Token-2022 akun=3 tag=14` berarti instruksi `MintToChecked` sudah benar.

### Troubleshooting Devnet

| Gejala | Penyebab & solusi |
| :--- | :--- |
| `Attempt to load a program that does not exist` | Program belum ter-deploy di devnet / program ID tidak sama dengan `declare_id!`. Jalankan `anchor keys sync` lalu `anchor deploy --provider.cluster devnet`. |
| `Saldo SOL wallet tidak cukup…` | Klik **Airdrop 1 SOL** (mock keypair) atau hubungkan Phantom berisi SOL devnet, atau faucet.solana.com. |
| `RPC … menolak karena rate-limit (429)` | Isi `VITE_RPC_ENDPOINT` di file `.env` (salin dari `.env.example`) dengan RPC devnet lain (Helius/QuickNode). |
| `Airdrop gagal` | Rate limit faucet RPC publik — pakai faucet.solana.com atau RPC berbayar. |
| `Blockhash kedaluwarsa` | Kirim ulang; pipeline selalu mengambil blockhash baru sebelum tanda tangan. |
| Transaksi sukses tapi saldo token 0 | Cek `Telemetry → initialize_pool (17B)` dan pastikan program yang dipanggil adalah versi terbaru (`anchor upgrade` bila perlu). |

## Catatan Perbaikan Terakhir

- Struktur file dipulihkan ke layout yang diharapkan tooling (`src/`, `tests/`, `programs/mini-amm/`) sehingga `tsc`, `npm test`, `npm run build`, dan `anchor build` berjalan.
- `index.html` sebelumnya memuat bundle hashed (`/assets/index-*.js`) yang tidak ada di repo (halaman blank); sekarang memuat `/src/main.tsx`. Artefak build lama di root dihapus (di-generate ulang ke `dist/`, sudah di-.gitignore).
- `Cargo.toml` root kini workspace Rust dan konfigurasi program dipindah ke `programs/mini-amm/Cargo.toml`; `Anchor.toml` diperbarui (fitur `resolution` yang sudah usang dihapus, script test ditambahkan).
- `virtual_reserves_y` diset **0** (sebelumnya `initial_real_token_y`, membuat token Y terhitung dua kali dan suplai LP tidak konsisten dengan `k`).
- Constraint vault diperketat (`token::mint`, `token::authority = pool_state`) pada `add_liquidity` dan `swap`.
- `buildCreatePoolTx()` kini membuat ATA token Y lebih dulu (sebelumnya transaksi gagal `AccountNotInitialized` bila pengguna belum punya ATA).
- `buildMintToCheckedInstruction()` sebelumnya mengirim **4** `AccountMeta` (menyisipkan `mint` read-only di indeks 1, layout `TransferChecked`). Token-2022 lalu membaca akun **Mint** sebagai `destination`, sehingga transaksi gagal `Error processing Instruction 8: instruction requires an initialized account` (`Program log: Error: UninitializedAccount`). Sekarang layout benar: `[mint, destination ATA, mint_authority]`, dan ada uji regresi yang memastikan `destination` sama dengan ATA hasil `CreateIdempotent` sebelumnya.
- Pesan error preflight kini mengenali `UninitializedAccount` dan menyebut nomor instruksi yang gagal beserta saran perbaikannya.
- **Fee creator**: `PoolState` naik ke 281 B (`creator`, `fee_vault_x`, `fee_vault_y`), `initialize_pool` kini 17 akun, `swap` 12 akun, dan ada instruksi baru `claim_creator_fee` (disc `3`). Fee swap 0.30% dipecah 0.24% LP + 0.06% creator tanpa mengubah invariant `k`. Ditambah CLI `npm run claim:creator`, kartu Fee Creator di dashboard, dan uji `tests/verifyClaimCreator.ts`.
- Header dashboard menampilkan stempel build (`SDK_BUILD_TAG`) + `console.table` ringkasan instruksi agar mudah memastikan bundle yang berjalan sudah terbaru.
- Dashboard: kegagalan swap tidak lagi ditandai `SUCCESS`, dan estimasi quote pembelian awal memakai cadangan efektif yang benar.
- Uji tambahan: edge-case parser/matematika, ukuran transaksi, dan konsistensi `LP_awal = sqrt(k)`.

### Perbaikan jalur Devnet

- `signAndDispatch` sebelumnya mengambil blockhash **baru setelah** transaksi dikirim dan **tidak pernah memeriksa** `confirmation.value.err` → transaksi gagal dilaporkan sukses. Sekarang blockhash dipakai konsisten untuk sign + confirm dan `err` selalu dicek.
- Pesan error RPC/preflight diterjemahkan (`program belum ter-deploy`, saldo kurang, rate-limit, blockhash kedaluwarsa, ditolak wallet) termasuk 3 log terakhir program.
- Compute unit limit eksplisit untuk transaksi clone (600k CU) dan AMM (300k CU).
- Guard saldo devnet (< 0.05 SOL ditolak lebih awal) + chip saldo + tombol **Airdrop 1 SOL** untuk wallet mock.
- Endpoint RPC bisa dioverride via `VITE_RPC_ENDPOINT` (`.env.example`), host RPC ditampilkan di header.
- Swap jual sekarang meng-unwrap WSOL → SOL native (`CloseAccount`, opsi `unwrapWsol` di SDK).
- `scripts/devnetPreflight.ts` (`npm run devnet:check`): cek RPC, status program executable, saldo wallet, airdrop opsional, dan artefak `target/deploy/mini_amm.so`.

### Fitur Pinata (IPFS)

- `scripts/pinataUpload.ts` (`npm run pinata:upload` / `pinata:check`): upload gambar + JSON
  metadata ke IPFS memakai REST API Pinata (tanpa dependensi). Memperbaiki bug pada versi
  awal: URL gateway (`gateway.pinata.cloud/ipfs/<hash>`, bukan `pinata.cloud{hash}`),
  interpolasi hash, validasi env/file, serta pemetaan error HTTP.
- `CloneTokenParams.metadataUri` (opsional): memisahkan `uri` on-chain (JSON) dari
  `imageUri` (gambar di dalam JSON). Dashboard punya kolom **Metadata JSON URI**.
- `tests/verifyPinata.ts`: uji parser `.env`, validasi file/argumen, bentuk metadata,
  pipeline upload end-to-end vs mock server HTTP, dan penanganan 401.
- `scripts/pinataDevApi.ts`: dev API `GET /api/pinata/status` + `POST /api/pinata/upload`
  (Vite middleware) agar dashboard bisa upload lewat file picker tanpa pernah memegang secret;
  kolom Image URI & Metadata JSON URI terisi otomatis.
- `tests/verifyPinataApi.ts`: uji endpoint dev (status, 405/400/413/503/502/200) terhadap
  mock Pinata, termasuk pembersihan file sementara.
