use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{
        self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
    },
};

declare_id!("Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp");

pub const AMM_POOL_SEED: &[u8] = b"amm_pool";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const VAULT_X_SEED: &[u8] = b"vault_x";
pub const VAULT_Y_SEED: &[u8] = b"vault_y";
pub const FEE_VAULT_X_SEED: &[u8] = b"fee_vault_x";
pub const FEE_VAULT_Y_SEED: &[u8] = b"fee_vault_y";

/// Total fee swap = 30 bps (0.30%) dari `amount_in`, dipecah menjadi:
///   - 24 bps (0.24%) -> LP (tertinggal di vault_x / vault_y, memperbesar `k`)
///   -  6 bps (0.06%) -> creator pool (masuk `fee_vault_x` / `fee_vault_y`, diklaim manual)
///
/// Fee creator = 20% dari total fee 0.30%.
pub const BPS_DENOMINATOR: u128 = 10_000;
pub const TOTAL_FEE_BPS: u128 = 30;
pub const CREATOR_FEE_BPS: u128 = 6;
pub const LP_FEE_BPS: u128 = TOTAL_FEE_BPS - CREATOR_FEE_BPS; // 24

#[program]
pub mod mini_amm {
    use super::*;

    /// Discriminator [0]: Menginisialisasi pool dengan metode VIRTUAL LIQUIDITY sejak detik 0.
    /// Mendukung Token SPL standar maupun Token-2022 melalui `TokenInterface` & `TransferChecked`.
    #[instruction(discriminator = [0])]
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        initial_real_token_y: u64, // Pasokan Token Proyek fisik awal (misal: 1 Milyar * 10^9)
        virtual_reserves_x: u64,   // Likuiditas Bayangan SOL awal dalam lamports (misal: 30 SOL)
    ) -> Result<()> {
        require_keys_neq!(
            ctx.accounts.token_x.key(),
            ctx.accounts.token_y.key(),
            AmmError::IdenticalTokenMints
        );
        require!(
            initial_real_token_y > 0 && virtual_reserves_x > 0,
            AmmError::ZeroLiquidityAmount
        );

        let bump = ctx.bumps.pool_state;
        let token_x_key = ctx.accounts.token_x.key();
        let token_y_key = ctx.accounts.token_y.key();

        let pool = &mut ctx.accounts.pool_state;
        pool.token_x = token_x_key;
        pool.token_y = token_y_key;
        pool.vault_x = ctx.accounts.vault_x.key();
        pool.vault_y = ctx.accounts.vault_y.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.creator = ctx.accounts.payer.key();
        pool.fee_vault_x = ctx.accounts.fee_vault_x.key();
        pool.fee_vault_y = ctx.accounts.fee_vault_y.key();

        // Set konfigurasi Virtual Curve di detik ke-0.
        //
        // CATATAN PENTING: cadangan efektif kurva = `vault.amount + virtual_reserves`.
        // Kreator menyetor 100% suplai token fisik ke `vault_y`, sehingga `vault_y.amount`
        // SUDAH merupakan seluruh cadangan token Y. Karena itu `virtual_reserves_y` harus 0
        // pada inisialisasi — jika diisi `initial_real_token_y` maka token Y akan terhitung
        // dua kali (harga awal & suplai LP menjadi tidak konsisten terhadap invariant k).
        pool.virtual_reserves_x = virtual_reserves_x;
        pool.virtual_reserves_y = 0;
        pool.bump = bump;

        // Transfer 100% token proyek fisik dari pembuat ke Vault AMM menggunakan transfer_checked (Aman untuk Token-2022)
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_y.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_y.to_account_info(),
                    to: ctx.accounts.vault_y.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                    mint: ctx.accounts.token_y.to_account_info(),
                },
            ),
            initial_real_token_y,
            ctx.accounts.token_y.decimals,
        )?;

        // Mint LP tokens awal berdasarkan perhitungan virtual matematika akar(x * y)
        let initial_lp = calculate_initial_lp_tokens(virtual_reserves_x, initial_real_token_y)?;

        let signer_seeds: &[&[&[u8]]] = &[&[
            AMM_POOL_SEED,
            token_x_key.as_ref(),
            token_y_key.as_ref(),
            &[bump],
        ]];

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_lp.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp_token.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            initial_lp,
        )?;

        Ok(())
    }

    /// Discriminator [1]: Menambah likuiditas fisik ekstra (Token X & Token Y) menggunakan `transfer_checked`
    /// yang kompatibel penuh dengan Token-2022 maupun SPL Token standar.
    #[instruction(discriminator = [1])]
    pub fn add_liquidity(
        ctx: Context<AddLiquidity>,
        amount_x: u64,
        amount_y: u64,
        min_lp_out: u64,
    ) -> Result<()> {
        require!(amount_x > 0 && amount_y > 0, AmmError::ZeroLiquidityAmount);

        let lp_supply = ctx.accounts.lp_mint.supply;
        let total_reserve_x = ctx
            .accounts
            .vault_x
            .amount
            .checked_add(ctx.accounts.pool_state.virtual_reserves_x)
            .ok_or(AmmError::MathOverflow)?;
        let total_reserve_y = ctx
            .accounts
            .vault_y
            .amount
            .checked_add(ctx.accounts.pool_state.virtual_reserves_y)
            .ok_or(AmmError::MathOverflow)?;

        let lp_to_mint = if lp_supply == 0 {
            calculate_initial_lp_tokens(amount_x, amount_y)?
        } else {
            require!(
                total_reserve_x > 0 && total_reserve_y > 0,
                AmmError::EmptyReserves
            );
            let share_x = mul_div_u128(
                u128::from(amount_x),
                u128::from(lp_supply),
                u128::from(total_reserve_x),
            )
            .ok_or(AmmError::MathOverflow)?;
            let share_y = mul_div_u128(
                u128::from(amount_y),
                u128::from(lp_supply),
                u128::from(total_reserve_y),
            )
            .ok_or(AmmError::MathOverflow)?;
            u64::try_from(share_x.min(share_y)).map_err(|_| AmmError::MathOverflow)?
        };

        require!(lp_to_mint > 0, AmmError::InsufficientLpMinted);
        require!(lp_to_mint >= min_lp_out, AmmError::SlippageExceeded);

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_x.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_x.to_account_info(),
                    to: ctx.accounts.vault_x.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.token_x.to_account_info(),
                },
            ),
            amount_x,
            ctx.accounts.token_x.decimals,
        )?;

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program_y.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token_y.to_account_info(),
                    to: ctx.accounts.vault_y.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.token_y.to_account_info(),
                },
            ),
            amount_y,
            ctx.accounts.token_y.decimals,
        )?;

        let token_x_key = ctx.accounts.pool_state.token_x;
        let token_y_key = ctx.accounts.pool_state.token_y;
        let bump = ctx.accounts.pool_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            AMM_POOL_SEED,
            token_x_key.as_ref(),
            token_y_key.as_ref(),
            &[bump],
        ]];

        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program_lp.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.user_lp_token.to_account_info(),
                    authority: ctx.accounts.pool_state.to_account_info(),
                },
                signer_seeds,
            ),
            lp_to_mint,
        )?;

        Ok(())
    }

    /// Discriminator [2]: Swap instan berbasis Virtual Liquidity + Real Reserves gabungan
    /// menggunakan `token_interface::transfer_checked` (Token-2022 & SPL kompatibel).
    #[instruction(discriminator = [2])]
    pub fn swap(
        ctx: Context<Swap>,
        amount_in: u64,
        min_amount_out: u64,
        x_to_y: bool,
    ) -> Result<()> {
        require!(amount_in > 0, AmmError::ZeroSwapAmount);

        let total_reserve_x = ctx
            .accounts
            .vault_x
            .amount
            .checked_add(ctx.accounts.pool_state.virtual_reserves_x)
            .ok_or(AmmError::MathOverflow)?;
        let total_reserve_y = ctx
            .accounts
            .vault_y
            .amount
            .checked_add(ctx.accounts.pool_state.virtual_reserves_y)
            .ok_or(AmmError::MathOverflow)?;

        let (reserve_in, reserve_out) = if x_to_y {
            (total_reserve_x, total_reserve_y)
        } else {
            (total_reserve_y, total_reserve_x)
        };

        let amount_out = calculate_swap_output(amount_in, reserve_in, reserve_out)?;
        require!(amount_out >= min_amount_out, AmmError::SlippageExceeded);

        // Fee creator (0.06%) dipotong dari `amount_in` SEBELUM masuk vault AMM,
        // sehingga cadangan vault (dan invariant k) tetap bersih dari fee creator.
        let creator_fee = calculate_creator_fee(amount_in)?;
        let net_in = amount_in
            .checked_sub(creator_fee)
            .ok_or(AmmError::MathOverflow)?;
        require!(net_in > 0, AmmError::ZeroSwapAmount);

        // Pastikan saldo fisik riil di vault tujuan mencukupi untuk ditransfer keluar
        if x_to_y {
            require!(
                amount_out <= ctx.accounts.vault_y.amount,
                AmmError::InsufficientVaultBalance
            );
        } else {
            require!(
                amount_out <= ctx.accounts.vault_x.amount,
                AmmError::InsufficientVaultBalance
            );
        }

        let token_x_key = ctx.accounts.pool_state.token_x;
        let token_y_key = ctx.accounts.pool_state.token_y;
        let bump = ctx.accounts.pool_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            AMM_POOL_SEED,
            token_x_key.as_ref(),
            token_y_key.as_ref(),
            &[bump],
        ]];

        if x_to_y {
            // Token X (SOL/WSOL) -> Fee Vault X (bagian creator)
            if creator_fee > 0 {
                token_interface::transfer_checked(
                    CpiContext::new(
                        ctx.accounts.token_program_x.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.user_token_x.to_account_info(),
                            to: ctx.accounts.fee_vault_x.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                            mint: ctx.accounts.token_x.to_account_info(),
                        },
                    ),
                    creator_fee,
                    ctx.accounts.token_x.decimals,
                )?;
            }
            // Token X (SOL/WSOL) -> Vault X (bagian LP)
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program_x.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.user_token_x.to_account_info(),
                        to: ctx.accounts.vault_x.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                        mint: ctx.accounts.token_x.to_account_info(),
                    },
                ),
                net_in,
                ctx.accounts.token_x.decimals,
            )?;
            // Vault Y -> Token Y (Token-2022 ke User)
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program_y.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_y.to_account_info(),
                        to: ctx.accounts.user_token_y.to_account_info(),
                        authority: ctx.accounts.pool_state.to_account_info(),
                        mint: ctx.accounts.token_y.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_out,
                ctx.accounts.token_y.decimals,
            )?;
        } else {
            // Token Y (Token-2022) -> Fee Vault Y (bagian creator)
            if creator_fee > 0 {
                token_interface::transfer_checked(
                    CpiContext::new(
                        ctx.accounts.token_program_y.to_account_info(),
                        TransferChecked {
                            from: ctx.accounts.user_token_y.to_account_info(),
                            to: ctx.accounts.fee_vault_y.to_account_info(),
                            authority: ctx.accounts.user.to_account_info(),
                            mint: ctx.accounts.token_y.to_account_info(),
                        },
                    ),
                    creator_fee,
                    ctx.accounts.token_y.decimals,
                )?;
            }
            // Token Y (Token-2022) -> Vault Y (bagian LP)
            token_interface::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program_y.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.user_token_y.to_account_info(),
                        to: ctx.accounts.vault_y.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                        mint: ctx.accounts.token_y.to_account_info(),
                    },
                ),
                net_in,
                ctx.accounts.token_y.decimals,
            )?;
            // Vault X -> Token X (SOL/WSOL ke User)
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program_x.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.vault_x.to_account_info(),
                        to: ctx.accounts.user_token_x.to_account_info(),
                        authority: ctx.accounts.pool_state.to_account_info(),
                        mint: ctx.accounts.token_x.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_out,
                ctx.accounts.token_x.decimals,
            )?;
        }

        Ok(())
    }

    /// Discriminator [3]: Klaim fee creator yang terakumulasi di `fee_vault_x` / `fee_vault_y`.
    ///
    /// Payload 10B: `[u8(3), u8(side), u64_le(min_amount)]`
    /// `side`: `0` = kedua sisi sekaligus, `1` = token X saja, `2` = token Y saja.
    /// `min_amount` = batas minimal per sisi yang diklaim (proteksi terhadap akumulasi
    /// yang belum layak diklaim / fee vault tiba-tiba kosong).
    #[instruction(discriminator = [3])]
    pub fn claim_creator_fee(
        ctx: Context<ClaimCreatorFee>,
        side: u8,
        min_amount: u64,
    ) -> Result<()> {
        require!(side <= 2, AmmError::InvalidClaimSide);

        let claim_x = side == 0 || side == 1;
        let claim_y = side == 0 || side == 2;

        let amount_x = if claim_x {
            ctx.accounts.fee_vault_x.amount
        } else {
            0
        };
        let amount_y = if claim_y {
            ctx.accounts.fee_vault_y.amount
        } else {
            0
        };

        require!(amount_x > 0 || amount_y > 0, AmmError::NothingToClaim);
        if claim_x {
            require!(amount_x >= min_amount, AmmError::ClaimBelowMinimum);
        }
        if claim_y {
            require!(amount_y >= min_amount, AmmError::ClaimBelowMinimum);
        }

        let token_x_key = ctx.accounts.pool_state.token_x;
        let token_y_key = ctx.accounts.pool_state.token_y;
        let bump = ctx.accounts.pool_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[
            AMM_POOL_SEED,
            token_x_key.as_ref(),
            token_y_key.as_ref(),
            &[bump],
        ]];

        if amount_x > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program_x.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.fee_vault_x.to_account_info(),
                        to: ctx.accounts.creator_token_x.to_account_info(),
                        authority: ctx.accounts.pool_state.to_account_info(),
                        mint: ctx.accounts.token_x.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_x,
                ctx.accounts.token_x.decimals,
            )?;
        }

        if amount_y > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program_y.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.fee_vault_y.to_account_info(),
                        to: ctx.accounts.creator_token_y.to_account_info(),
                        authority: ctx.accounts.pool_state.to_account_info(),
                        mint: ctx.accounts.token_y.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount_y,
                ctx.accounts.token_y.decimals,
            )?;
        }

        emit!(CreatorFeeClaimed {
            pool: ctx.accounts.pool_state.key(),
            creator: ctx.accounts.creator.key(),
            side,
            amount_x,
            amount_y,
        });

        Ok(())
    }
}

/// Event `claim_creator_fee` (tercatat di transaksi, mudah dibaca indexer/script).
#[event]
pub struct CreatorFeeClaimed {
    pub pool: Pubkey,
    pub creator: Pubkey,
    pub side: u8,
    pub amount_x: u64,
    pub amount_y: u64,
}

// --- LOGIKA MATEMATIKA AMM (STABIL & BEBAS OVERFLOW U128/U256) ---

pub fn calculate_initial_lp_tokens(amount_x: u64, amount_y: u64) -> Result<u64> {
    require!(amount_x > 0 && amount_y > 0, AmmError::ZeroLiquidityAmount);
    let product = u128::from(amount_x)
        .checked_mul(u128::from(amount_y))
        .ok_or(AmmError::MathOverflow)?;
    let lp = integer_sqrt_u128(product);
    require!(lp > 0, AmmError::InsufficientLpMinted);
    u64::try_from(lp).map_err(|_| AmmError::MathOverflow.into())
}

/// Fee creator = 0.06% dari `amount_in` (6 bps), dipotong dari input sebelum masuk vault.
pub fn calculate_creator_fee(amount_in: u64) -> Result<u64> {
    let fee = mul_div_u128(u128::from(amount_in), CREATOR_FEE_BPS, BPS_DENOMINATOR)
        .ok_or(AmmError::MathOverflow)?;
    u64::try_from(fee).map_err(|_| AmmError::MathOverflow.into())
}

/// Output swap: fee creator dipotong lebih dulu, lalu sisa input dikenai fee LP 24 bps
/// (konstanta produk). Total beban swap tetap ~0.30%: 0.06% creator + 0.24% LP.
pub fn calculate_swap_output(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    require!(amount_in > 0, AmmError::ZeroSwapAmount);
    require!(reserve_in > 0 && reserve_out > 0, AmmError::EmptyReserves);

    let creator_fee = calculate_creator_fee(amount_in)?;
    let net_in = amount_in
        .checked_sub(creator_fee)
        .ok_or(AmmError::MathOverflow)?;
    require!(net_in > 0, AmmError::ZeroSwapAmount);

    let fee_retained = BPS_DENOMINATOR
        .checked_sub(LP_FEE_BPS)
        .ok_or(AmmError::MathOverflow)?;
    let amount_in_with_fee = u128::from(net_in)
        .checked_mul(fee_retained)
        .ok_or(AmmError::MathOverflow)?;
    let denominator = u128::from(reserve_in)
        .checked_mul(BPS_DENOMINATOR)
        .and_then(|v| v.checked_add(amount_in_with_fee))
        .ok_or(AmmError::MathOverflow)?;

    let amount_out_u128 =
        mul_div_u128(amount_in_with_fee, u128::from(reserve_out), denominator)
            .ok_or(AmmError::MathOverflow)?;
    let amount_out = u64::try_from(amount_out_u128).map_err(|_| AmmError::MathOverflow)?;

    require!(
        amount_out > 0 && amount_out < reserve_out,
        AmmError::InsufficientOutputAmount
    );
    Ok(amount_out)
}

pub fn integer_sqrt_u128(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let shift = (128 - n.leading_zeros() + 1) >> 1;
    let mut x0 = 1u128 << shift;
    let mut x1 = (x0 + n / x0) >> 1;
    while x1 < x0 {
        x0 = x1;
        x1 = (x0 + n / x0) >> 1;
    }
    x0
}

pub fn mul_div_u128(a: u128, b: u128, denominator: u128) -> Option<u128> {
    if denominator == 0 {
        return None;
    }
    if let Some(prod) = a.checked_mul(b) {
        return Some(prod / denominator);
    }

    let mask = 0xFFFF_FFFF_FFFF_FFFFu128;
    let a_lo = a & mask;
    let a_hi = a >> 64;
    let b_lo = b & mask;
    let b_hi = b >> 64;

    let p0 = a_lo * b_lo;
    let p1 = a_lo * b_hi;
    let p2 = a_hi * b_lo;
    let p3 = a_hi * b_hi;

    let mid = (p0 >> 64) + (p1 & mask) + (p2 & mask);
    let lo = (p0 & mask) | (mid << 64);
    let hi = p3 + (p1 >> 64) + (p2 >> 64) + (mid >> 64);

    if hi >= denominator {
        return None;
    }

    let mut rem = hi;
    let mut quot = 0u128;
    for i in (0..128).rev() {
        let carry = (rem >> 127) != 0;
        rem = (rem << 1) | ((lo >> i) & 1);
        if carry || rem >= denominator {
            rem = rem.wrapping_sub(denominator);
            quot |= 1u128 << i;
        }
    }
    Some(quot)
}

/// Akun PoolState Token-2022 Virtual Liquidity AMM (8B discriminator + 273B = 281 bytes)
#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub token_x: Pubkey,          // 32B (8..40)     Mint Token X (misal: WSOL)
    pub token_y: Pubkey,          // 32B (40..72)    Mint Token Y (Token-2022 Proyek)
    pub vault_x: Pubkey,          // 32B (72..104)   Vault penampung Token X riil
    pub vault_y: Pubkey,          // 32B (104..136)  Vault penampung Token Y riil
    pub lp_mint: Pubkey,          // 32B (136..168)  Mint LP Token
    pub creator: Pubkey,          // 32B (168..200)  Wallet pembuat pool (penerima fee creator)
    pub fee_vault_x: Pubkey,      // 32B (200..232)  Penampung fee creator dalam Token X
    pub fee_vault_y: Pubkey,      // 32B (232..264)  Penampung fee creator dalam Token Y
    pub virtual_reserves_x: u64,  // 8B  (264..272)  Likuiditas bayangan X (misal: 30 SOL)
    pub virtual_reserves_y: u64,  // 8B  (272..280)  Likuiditas bayangan Y (0 pada inisialisasi)
    pub bump: u8,                 // 1B  (280..281)  Canonical PDA bump
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mint::token_program = token_program_x)]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mint::token_program = token_program_y,
        constraint = token_x.key() != token_y.key() @ AmmError::IdenticalTokenMints
    )]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        space = PoolState::DISCRIMINATOR.len() + PoolState::INIT_SPACE,
        seeds = [b"amm_pool", token_x.key().as_ref(), token_y.key().as_ref()],
        bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        init,
        payer = payer,
        seeds = [LP_MINT_SEED, pool_state.key().as_ref()],
        bump,
        mint::decimals = 9,
        mint::authority = pool_state,
        mint::token_program = token_program_lp,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_X_SEED, pool_state.key().as_ref()],
        bump,
        token::mint = token_x,
        token::authority = pool_state,
        token::token_program = token_program_x,
    )]
    pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = payer,
        seeds = [VAULT_Y_SEED, pool_state.key().as_ref()],
        bump,
        token::mint = token_y,
        token::authority = pool_state,
        token::token_program = token_program_y,
    )]
    pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Penampung fee creator sisi Token X (0.06% tiap swap X -> Y).
    #[account(
        init,
        payer = payer,
        seeds = [FEE_VAULT_X_SEED, pool_state.key().as_ref()],
        bump,
        token::mint = token_x,
        token::authority = pool_state,
        token::token_program = token_program_x,
    )]
    pub fee_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Penampung fee creator sisi Token Y (0.06% tiap swap Y -> X).
    #[account(
        init,
        payer = payer,
        seeds = [FEE_VAULT_Y_SEED, pool_state.key().as_ref()],
        bump,
        token::mint = token_y,
        token::authority = pool_state,
        token::token_program = token_program_y,
    )]
    pub fee_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = payer,
        token::token_program = token_program_y,
    )]
    pub user_token_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = lp_mint,
        associated_token::authority = payer,
        associated_token::token_program = token_program_lp,
    )]
    pub user_lp_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub token_program_lp: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        address = pool_state.token_x @ AmmError::InvalidTokenMint,
        mint::token_program = token_program_x,
    )]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        address = pool_state.token_y @ AmmError::InvalidTokenMint,
        mint::token_program = token_program_y,
    )]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [AMM_POOL_SEED, pool_state.token_x.as_ref(), pool_state.token_y.as_ref()],
        bump = pool_state.bump,
        has_one = vault_x @ AmmError::InvalidVault,
        has_one = vault_y @ AmmError::InvalidVault,
        has_one = lp_mint @ AmmError::InvalidLpMint,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        mut,
        mint::token_program = token_program_lp,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    // `token::*` constraint tidak mendukung custom error (`@ AmmError::..`),
    // jadi hanya constraint polos yang dipakai di sini.
    #[account(
        mut,
        token::mint = token_x,
        token::authority = pool_state,
        token::token_program = token_program_x,
    )]
    pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = pool_state,
        token::token_program = token_program_y,
    )]
    pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_x,
        token::authority = user,
        token::token_program = token_program_x,
    )]
    pub user_token_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = user,
        token::token_program = token_program_y,
    )]
    pub user_token_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = lp_mint,
        token::authority = user,
        token::token_program = token_program_lp,
    )]
    pub user_lp_token: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
    pub token_program_lp: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        address = pool_state.token_x @ AmmError::InvalidTokenMint,
        mint::token_program = token_program_x,
    )]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        address = pool_state.token_y @ AmmError::InvalidTokenMint,
        mint::token_program = token_program_y,
    )]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        seeds = [AMM_POOL_SEED, pool_state.token_x.as_ref(), pool_state.token_y.as_ref()],
        bump = pool_state.bump,
        has_one = vault_x @ AmmError::InvalidVault,
        has_one = vault_y @ AmmError::InvalidVault,
        has_one = fee_vault_x @ AmmError::InvalidFeeVault,
        has_one = fee_vault_y @ AmmError::InvalidFeeVault,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    // `token::*` constraint tidak mendukung custom error (`@ AmmError::..`),
    // jadi hanya constraint polos yang dipakai di sini.
    #[account(
        mut,
        token::mint = token_x,
        token::authority = pool_state,
        token::token_program = token_program_x,
    )]
    pub vault_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = pool_state,
        token::token_program = token_program_y,
    )]
    pub vault_y: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Penampung fee creator sisi Token X — wajib ikut agar akumulasi 0.06% konsisten.
    #[account(
        mut,
        token::mint = token_x,
        token::authority = pool_state,
        token::token_program = token_program_x,
    )]
    pub fee_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Penampung fee creator sisi Token Y.
    #[account(
        mut,
        token::mint = token_y,
        token::authority = pool_state,
        token::token_program = token_program_y,
    )]
    pub fee_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_x,
        token::authority = user,
        token::token_program = token_program_x,
    )]
    pub user_token_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = user,
        token::token_program = token_program_y,
    )]
    pub user_token_y: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimCreatorFee<'info> {
    /// Penerima fee — wajib sama dengan `pool_state.creator`.
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(
        seeds = [AMM_POOL_SEED, pool_state.token_x.as_ref(), pool_state.token_y.as_ref()],
        bump = pool_state.bump,
        has_one = creator @ AmmError::InvalidCreator,
        has_one = fee_vault_x @ AmmError::InvalidFeeVault,
        has_one = fee_vault_y @ AmmError::InvalidFeeVault,
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        address = pool_state.token_x @ AmmError::InvalidTokenMint,
        mint::token_program = token_program_x,
    )]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        address = pool_state.token_y @ AmmError::InvalidTokenMint,
        mint::token_program = token_program_y,
    )]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        token::mint = token_x,
        token::authority = pool_state,
        token::token_program = token_program_x,
    )]
    pub fee_vault_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = pool_state,
        token::token_program = token_program_y,
    )]
    pub fee_vault_y: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_x,
        token::authority = creator,
        token::token_program = token_program_x,
    )]
    pub creator_token_x: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = token_y,
        token::authority = creator,
        token::token_program = token_program_y,
    )]
    pub creator_token_y: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program_x: Interface<'info, TokenInterface>,
    pub token_program_y: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum AmmError {
    #[msg("Token X and Token Y mints must be distinct")]
    IdenticalTokenMints,
    #[msg("Liquidity deposit amounts must be strictly greater than zero")]
    ZeroLiquidityAmount,
    #[msg("Swap input amount must be strictly greater than zero")]
    ZeroSwapAmount,
    #[msg("Pool vaults have zero active reserves")]
    EmptyReserves,
    #[msg("Physical vault balance is insufficient for swap output")]
    InsufficientVaultBalance,
    #[msg("Arithmetic overflow or division by zero in AMM curve")]
    MathOverflow,
    #[msg("Initial or proportional LP tokens minted rounded to zero")]
    InsufficientLpMinted,
    #[msg("Computed swap output amount is zero or exhausts reserve")]
    InsufficientOutputAmount,
    #[msg("Output fell below user slippage tolerance")]
    SlippageExceeded,
    #[msg("Provided token mint does not match PoolState")]
    InvalidTokenMint,
    #[msg("Provided vault account does not match PoolState")]
    InvalidVault,
    #[msg("Provided LP mint account does not match PoolState")]
    InvalidLpMint,
    #[msg("Signer is not the creator of this pool")]
    InvalidCreator,
    #[msg("Provided fee vault account does not match PoolState")]
    InvalidFeeVault,
    #[msg("Claim side must be 0 (both), 1 (token X) or 2 (token Y)")]
    InvalidClaimSide,
    #[msg("Creator fee vaults are empty — nothing to claim")]
    NothingToClaim,
    #[msg("Accumulated creator fee is below the requested minimum")]
    ClaimBelowMinimum,
}
