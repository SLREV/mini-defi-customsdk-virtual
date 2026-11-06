# Mini DeFi Custom SDK — Leveraged Virtual-Reserve AMM

Solana Anchor AMM dan launchpad sederhana untuk SPL Token maupun Token-2022. Program memakai Token Interface Anchor, sehingga transfer token menggunakan `transfer_checked` dan dapat bekerja lintas kedua program token.

## Model AMM

- Token X umumnya Wrapped SOL (WSOL); Token Y adalah token proyek.
- Saat pool dibuat, pembuat menyetor **Token X dan Token Y fisik** ke vault.
- `virtual_reserves_x = real_sol_deposited × 10`; `virtual_reserves_y = 0`. Multiplier 10x hanya mengubah cadangan yang dipakai kurva dan perhitungan LP—bukan pinjaman atau tambahan aset yang dapat ditarik.
- Cadangan efektif untuk quote adalah `vault.amount + virtual_reserves`. Output tetap dibatasi saldo fisik vault tujuan.
- Biaya swap 0,30% dipertahankan di vault pool: `amount_in_after_fee = amount_in × 997`, lalu output dihitung dengan kurva constant-product.
- LP awal dihitung sebagai `sqrt(virtual_reserves_x × initial_real_token_y)`. Likuiditas tambahan memakai proporsi cadangan efektif.

**Perhatian:** cadangan virtual memengaruhi harga, quote, dan jumlah LP; bukan aset riil. Periksa solvabilitas fisik dan risiko harga sebelum memakai dana nyata.

## Instruksi dan layout

| Instruksi | Discriminator | Payload | Ringkasan akun |
| --- | ---: | ---: | --- |
| `initialize_pool` | `0` | 17 byte: `[u8(0), u64_le(initial_real_token_y), u64_le(real_sol_deposited)]` | payer, 2 mint, pool, LP mint, 2 vault, 2 akun token depositor, akun LP, 3 token program, ATA, system, rent (16 akun) |
| `add_liquidity` | `1` | 25 byte: `[u8(1), u64_le(amount_x), u64_le(amount_y), u64_le(min_lp_out)]` | user, 2 mint, pool, LP mint, 2 vault, 2 akun token user, akun LP, 3 token program (13 akun) |
| `swap` | `2` | 18 byte: `[u8(2), u64_le(amount_in), u64_le(min_amount_out), u8(x_to_y)]` | user, 2 mint, pool, 2 vault, 2 akun token user, 2 token program (10 akun) |

`PoolState` berukuran **185 byte** termasuk discriminator Anchor: 5 Pubkey, 2 `u64` virtual reserve, dan 1 byte bump. PDA pool memakai seed `amm_pool + token_x + token_y`; seed lainnya `lp_mint`, `vault_x`, dan `vault_y` dengan alamat pool sebagai seed berikutnya.

## Menjalankan

Prasyarat: Node.js 18+, npm 9+, dan (untuk program on-chain) Rust/Solana CLI/Anchor 0.31.1.

```bash
npm ci
npm run dev       # dashboard lokal, Vite port 5173
npm run typecheck
npm test
npm run build
```

Perintah Anchor yang tersedia:

```bash
anchor build
anchor test
anchor deploy --provider.cluster devnet
```

Dashboard menyediakan mode Sandbox dan Devnet. Di Devnet, wallet memerlukan SOL untuk biaya transaksi, rent, dan deposit Token X awal. Instruksi SDK membungkus SOL ke WSOL sebelum inisialisasi pool. Jumlah SOL yang dimasukkan saat membuat pool adalah **deposit riil**; virtual reserve X menjadi 10 kali jumlah tersebut.

## Struktur proyek

```text
programs/mini-amm/src/lib.rs  Program Anchor AMM
src/sdk/customSdk.ts          Builder transaksi, PDA, quote, dan decoder PoolState
src/App.tsx                   Dashboard launchpad dan swap
scripts/                      Utilitas Pinata dan pemeriksaan devnet
 tests/                       Verifikasi SDK dan integrasi utilitas
```

## Batasan penting

- Swap dapat ditolak bila output hasil kurva lebih besar daripada saldo fisik vault tujuan, meskipun cadangan efektif virtual terlihat cukup.
- Token-2022 dengan extension transfer-fee dapat menyebabkan saldo yang diterima berbeda dari jumlah nominal; cek konfigurasi mint sebelum menginisialisasi pool.
- Program memakai discriminator instruksi satu byte eksplisit untuk SDK kustom; jangan mengubahnya tanpa memperbarui builder, dashboard, dan test bersamaan.
- Perubahan layout `PoolState` tidak kompatibel dengan state pool lama 281 byte yang sebelumnya menyimpan fee-vault/creator. Pool lama perlu tetap dibaca menggunakan decoder lama atau dimigrasikan secara terpisah; jangan menganggap akun lama sebagai pool format baru.
