use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked},
};

declare_id!("Csre71k9LDyYGx4t2hiG6VT4wiymuhPVXeksqe6Z83Hp");

pub const AMM_POOL_SEED: &[u8] = b"amm_pool";
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
pub const VAULT_X_SEED: &[u8] = b"vault_x";
pub const VAULT_Y_SEED: &[u8] = b"vault_y";
/// Fee swap 0.30%: 997/1000 input efektif masuk ke kurva.
pub const FEE_NUMERATOR: u128 = 3;
pub const FEE_DENOMINATOR: u128 = 1_000;
pub const MULTIPLIER: u64 = 10;

#[program]
pub mod mini_amm {
    use super::*;

    /// Discriminator [0]: Menginisialisasi pool dengan metode VIRTUAL LIQUIDITY sejak detik 0.
    /// Mendukung Token SPL standar maupun Token-2022 melalui `TokenInterface` & `TransferChecked`.
    #[instruction(discriminator = [0])]
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        initial_real_token_y: u64,
        real_sol_deposited: u64,
    ) -> Result<()> {
        require_keys_neq!(ctx.accounts.token_x.key(), ctx.accounts.token_y.key(), AmmError::IdenticalTokenMints);
        require!(initial_real_token_y > 0 && real_sol_deposited > 0, AmmError::ZeroLiquidityAmount);

        let bump = ctx.bumps.pool_state;
        let token_x_key = ctx.accounts.token_x.key();
        let token_y_key = ctx.accounts.token_y.key();
        let leveraged_virtual_x = real_sol_deposited.checked_mul(MULTIPLIER).ok_or(AmmError::MathOverflow)?;

        let pool = &mut ctx.accounts.pool_state;
        pool.token_x = token_x_key;
        pool.token_y = token_y_key;
        pool.vault_x = ctx.accounts.vault_x.key();
        pool.vault_y = ctx.accounts.vault_y.key();
        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.virtual_reserves_x = leveraged_virtual_x;
        pool.virtual_reserves_y = 0;
        pool.bump = bump;

        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program_x.to_account_info(), TransferChecked {
                from: ctx.accounts.user_token_x.to_account_info(), to: ctx.accounts.vault_x.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(), mint: ctx.accounts.token_x.to_account_info(),
            }), real_sol_deposited, ctx.accounts.token_x.decimals,
        )?;
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program_y.to_account_info(), TransferChecked {
                from: ctx.accounts.user_token_y.to_account_info(), to: ctx.accounts.vault_y.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(), mint: ctx.accounts.token_y.to_account_info(),
            }), initial_real_token_y, ctx.accounts.token_y.decimals,
        )?;

        let initial_lp = calculate_initial_lp_tokens(leveraged_virtual_x, initial_real_token_y)?;
        let signer_seeds: &[&[&[u8]]] = &[&[AMM_POOL_SEED, token_x_key.as_ref(), token_y_key.as_ref(), &[bump]]];
        token_interface::mint_to(CpiContext::new_with_signer(
            ctx.accounts.token_program_lp.to_account_info(),
            MintTo { mint: ctx.accounts.lp_mint.to_account_info(), to: ctx.accounts.user_lp_token.to_account_info(), authority: ctx.accounts.pool_state.to_account_info() },
            signer_seeds,
        ), initial_lp)?;
        Ok(())
    }

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
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_amount_out: u64, x_to_y: bool) -> Result<()> {
        require!(amount_in > 0, AmmError::ZeroSwapAmount);
        let reserve_x = ctx.accounts.vault_x.amount.checked_add(ctx.accounts.pool_state.virtual_reserves_x).ok_or(AmmError::MathOverflow)?;
        let reserve_y = ctx.accounts.vault_y.amount.checked_add(ctx.accounts.pool_state.virtual_reserves_y).ok_or(AmmError::MathOverflow)?;
        let (reserve_in, reserve_out) = if x_to_y { (reserve_x, reserve_y) } else { (reserve_y, reserve_x) };
        let amount_out = calculate_swap_output(amount_in, reserve_in, reserve_out)?;
        require!(amount_out >= min_amount_out, AmmError::SlippageExceeded);
        let physical_out = if x_to_y { ctx.accounts.vault_y.amount } else { ctx.accounts.vault_x.amount };
        require!(amount_out <= physical_out, AmmError::InsufficientVaultBalance);

        let token_x_key = ctx.accounts.pool_state.token_x;
        let token_y_key = ctx.accounts.pool_state.token_y;
        let bump = ctx.accounts.pool_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[AMM_POOL_SEED, token_x_key.as_ref(), token_y_key.as_ref(), &[bump]]];
        if x_to_y {
            token_interface::transfer_checked(CpiContext::new(ctx.accounts.token_program_x.to_account_info(), TransferChecked {
                from: ctx.accounts.user_token_x.to_account_info(), to: ctx.accounts.vault_x.to_account_info(), authority: ctx.accounts.user.to_account_info(), mint: ctx.accounts.token_x.to_account_info(),
            }), amount_in, ctx.accounts.token_x.decimals)?;
            token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program_y.to_account_info(), TransferChecked {
                from: ctx.accounts.vault_y.to_account_info(), to: ctx.accounts.user_token_y.to_account_info(), authority: ctx.accounts.pool_state.to_account_info(), mint: ctx.accounts.token_y.to_account_info(),
            }, signer_seeds), amount_out, ctx.accounts.token_y.decimals)?;
        } else {
            token_interface::transfer_checked(CpiContext::new(ctx.accounts.token_program_y.to_account_info(), TransferChecked {
                from: ctx.accounts.user_token_y.to_account_info(), to: ctx.accounts.vault_y.to_account_info(), authority: ctx.accounts.user.to_account_info(), mint: ctx.accounts.token_y.to_account_info(),
            }), amount_in, ctx.accounts.token_y.decimals)?;
            token_interface::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program_x.to_account_info(), TransferChecked {
                from: ctx.accounts.vault_x.to_account_info(), to: ctx.accounts.user_token_x.to_account_info(), authority: ctx.accounts.pool_state.to_account_info(), mint: ctx.accounts.token_x.to_account_info(),
            }, signer_seeds), amount_out, ctx.accounts.token_x.decimals)?;
        }
        Ok(())
    }

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

/// Constant-product output with a 0.30% fee retained by the pool.
pub fn calculate_swap_output(amount_in: u64, reserve_in: u64, reserve_out: u64) -> Result<u64> {
    require!(amount_in > 0, AmmError::ZeroSwapAmount);
    require!(reserve_in > 0 && reserve_out > 0, AmmError::EmptyReserves);
    let fee_retained = FEE_DENOMINATOR.checked_sub(FEE_NUMERATOR).ok_or(AmmError::MathOverflow)?;
    let amount_in_after_fee = u128::from(amount_in).checked_mul(fee_retained).ok_or(AmmError::MathOverflow)?;
    let numerator = amount_in_after_fee.checked_mul(u128::from(reserve_out)).ok_or(AmmError::MathOverflow)?;
    let denominator = u128::from(reserve_in).checked_mul(FEE_DENOMINATOR)
        .and_then(|v| v.checked_add(amount_in_after_fee)).ok_or(AmmError::MathOverflow)?;
    let amount_out = u64::try_from(numerator / denominator).map_err(|_| AmmError::MathOverflow)?;
    require!(amount_out > 0 && amount_out < reserve_out, AmmError::InsufficientOutputAmount);
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

/// PoolState: 8B discriminator + 5 Pubkeys + 2 u64 reserves + 1B bump = 185 bytes
#[account]
#[derive(InitSpace)]
pub struct PoolState {
    pub token_x: Pubkey,          // 32B (8..40)     Mint Token X (misal: WSOL)
    pub token_y: Pubkey,          // 32B (40..72)    Mint Token Y (Token-2022 Proyek)
    pub vault_x: Pubkey,          // 32B (72..104)   Vault penampung Token X riil
    pub vault_y: Pubkey,          // 32B (104..136)  Vault penampung Token Y riil
    pub lp_mint: Pubkey,          // 32B (136..168)  Mint LP Token
    pub virtual_reserves_x: u64,
    pub virtual_reserves_y: u64,
    pub bump: u8,
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


    #[account(mut, token::mint = token_x, token::authority = payer, token::token_program = token_program_x)]
    pub user_token_x: Box<InterfaceAccount<'info, TokenAccount>>,

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
}
