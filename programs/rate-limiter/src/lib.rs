use anchor_lang::prelude::*;

declare_id!("7mF84Hg6TAS48ZffjC1mqWydj96rcgUMuo3RvcJymbka");

#[program]
pub mod rate_limiter {
    use super::*;

    /// Create a rate limit config for a named resource.
    /// One config per (authority, resource_id) pair.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        resource_id: String,
        max_requests: u32,
        window_seconds: i64,
    ) -> Result<()> {
        require!(resource_id.len() <= 32, RateLimiterError::ResourceIdTooLong);
        require!(max_requests > 0, RateLimiterError::InvalidMaxRequests);
        require!(window_seconds > 0, RateLimiterError::InvalidWindow);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.resource_id = resource_id.clone();
        config.max_requests = max_requests;
        config.window_seconds = window_seconds;
        config.total_requests = 0;
        config.bump = ctx.bumps.config;

        emit!(ConfigCreated {
            authority: config.authority,
            resource_id,
            max_requests,
            window_seconds,
        });

        Ok(())
    }

    /// Consume one request against a caller's rate limit.
    /// Creates the caller's state account on first use (caller pays rent).
    /// Resets the counter automatically when the window expires.
    pub fn check_rate_limit(ctx: Context<CheckRateLimit>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let state = &mut ctx.accounts.state;
        let now = Clock::get()?.unix_timestamp;

        // First-time setup for this caller
        if state.initialized == 0 {
            state.caller = ctx.accounts.caller.key();
            state.config = config.key();
            state.bump = ctx.bumps.state;
            state.initialized = 1;
            state.window_start = now;
            state.count = 0;
        }

        // Window expired — reset counter
        if now >= state.window_start + config.window_seconds {
            state.window_start = now;
            state.count = 0;
        }

        require!(
            state.count < config.max_requests,
            RateLimiterError::RateLimitExceeded
        );

        state.count += 1;
        config.total_requests += 1;

        emit!(RequestAllowed {
            caller: ctx.accounts.caller.key(),
            resource_id: config.resource_id.clone(),
            count: state.count,
            remaining: config.max_requests - state.count,
            resets_at: state.window_start + config.window_seconds,
        });

        Ok(())
    }

    /// Update the rate limit parameters. Authority only.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        max_requests: u32,
        window_seconds: i64,
    ) -> Result<()> {
        require!(max_requests > 0, RateLimiterError::InvalidMaxRequests);
        require!(window_seconds > 0, RateLimiterError::InvalidWindow);

        let config = &mut ctx.accounts.config;
        let old_max = config.max_requests;
        let old_window = config.window_seconds;
        config.max_requests = max_requests;
        config.window_seconds = window_seconds;

        emit!(ConfigUpdated {
            authority: config.authority,
            resource_id: config.resource_id.clone(),
            old_max_requests: old_max,
            old_window_seconds: old_window,
            new_max_requests: max_requests,
            new_window_seconds: window_seconds,
        });

        Ok(())
    }

    /// Reset a specific caller's rate limit state. Authority only.
    pub fn reset_caller(ctx: Context<ResetCaller>) -> Result<()> {
        let state = &mut ctx.accounts.state;
        let caller_key = state.caller;
        state.count = 0;
        state.window_start = 0;

        emit!(CallerReset {
            authority: ctx.accounts.authority.key(),
            caller: caller_key,
            config: ctx.accounts.config.key(),
        });

        Ok(())
    }

    /// Close a config account and reclaim rent. Authority only.
    /// Note: orphans any existing state accounts (they can still be closed by their callers).
    pub fn close_config(_ctx: Context<CloseConfig>) -> Result<()> {
        // Anchor's `close` constraint handles the lamport transfer
        Ok(())
    }

    /// Close your own state account and reclaim rent.
    /// Callers can do this when they no longer need rate limit access.
    pub fn close_state(_ctx: Context<CloseState>) -> Result<()> {
        Ok(())
    }
}

// ─── Instruction Accounts ───

#[derive(Accounts)]
#[instruction(resource_id: String)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = RateLimitConfig::SPACE_BASE + resource_id.len(),
        seeds = [b"rate_config", authority.key().as_ref(), resource_id.as_bytes()],
        bump
    )]
    pub config: Account<'info, RateLimitConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckRateLimit<'info> {
    #[account(
        mut,
        seeds = [b"rate_config", config.authority.as_ref(), config.resource_id.as_bytes()],
        bump = config.bump
    )]
    pub config: Account<'info, RateLimitConfig>,
    #[account(
        init_if_needed,
        payer = caller,
        space = RateLimitState::SPACE,
        seeds = [b"rate_state", config.key().as_ref(), caller.key().as_ref()],
        bump
    )]
    pub state: Account<'info, RateLimitState>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        has_one = authority,
        seeds = [b"rate_config", authority.key().as_ref(), config.resource_id.as_bytes()],
        bump = config.bump
    )]
    pub config: Account<'info, RateLimitConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ResetCaller<'info> {
    #[account(has_one = authority)]
    pub config: Account<'info, RateLimitConfig>,
    #[account(
        mut,
        seeds = [b"rate_state", config.key().as_ref(), target_caller.key().as_ref()],
        bump = state.bump
    )]
    pub state: Account<'info, RateLimitState>,
    pub authority: Signer<'info>,
    /// CHECK: Only used for PDA derivation — not read or written.
    pub target_caller: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CloseConfig<'info> {
    #[account(
        mut,
        close = authority,
        has_one = authority,
        seeds = [b"rate_config", authority.key().as_ref(), config.resource_id.as_bytes()],
        bump = config.bump
    )]
    pub config: Account<'info, RateLimitConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseState<'info> {
    pub config: Account<'info, RateLimitConfig>,
    #[account(
        mut,
        close = caller,
        seeds = [b"rate_state", config.key().as_ref(), caller.key().as_ref()],
        bump = state.bump
    )]
    pub state: Account<'info, RateLimitState>,
    #[account(mut)]
    pub caller: Signer<'info>,
}

// ─── State ───

#[account]
pub struct RateLimitConfig {
    pub authority: Pubkey,     // 32
    pub resource_id: String,   // 4 + len
    pub max_requests: u32,     // 4
    pub window_seconds: i64,   // 8
    pub total_requests: u64,   // 8
    pub bump: u8,              // 1
    // 32 bytes reserved for future fields (e.g. tier, paused flag)
    pub _padding: [u8; 32],    // 32
}

impl RateLimitConfig {
    // discriminator + authority + string_prefix + max_req + window + total + bump + padding
    pub const SPACE_BASE: usize = 8 + 32 + 4 + 4 + 8 + 8 + 1 + 32; // 97 + resource_id.len()
}

#[account]
pub struct RateLimitState {
    pub caller: Pubkey,       // 32
    pub config: Pubkey,       // 32
    pub count: u32,           // 4
    pub window_start: i64,    // 8
    pub bump: u8,             // 1
    pub initialized: u8,      // 1
}

impl RateLimitState {
    pub const SPACE: usize = 8 + 32 + 32 + 4 + 8 + 1 + 1;
}

// ─── Events ───

#[event]
pub struct ConfigCreated {
    pub authority: Pubkey,
    pub resource_id: String,
    pub max_requests: u32,
    pub window_seconds: i64,
}

#[event]
pub struct ConfigUpdated {
    pub authority: Pubkey,
    pub resource_id: String,
    pub old_max_requests: u32,
    pub old_window_seconds: i64,
    pub new_max_requests: u32,
    pub new_window_seconds: i64,
}

#[event]
pub struct RequestAllowed {
    pub caller: Pubkey,
    pub resource_id: String,
    pub count: u32,
    pub remaining: u32,
    pub resets_at: i64,
}

#[event]
pub struct CallerReset {
    pub authority: Pubkey,
    pub caller: Pubkey,
    pub config: Pubkey,
}

// ─── Errors ───

#[error_code]
pub enum RateLimiterError {
    #[msg("Rate limit exceeded — try again after the window resets.")]
    RateLimitExceeded,
    #[msg("Resource ID too long (max 32 bytes).")]
    ResourceIdTooLong,
    #[msg("max_requests must be > 0.")]
    InvalidMaxRequests,
    #[msg("window_seconds must be > 0.")]
    InvalidWindow,
}
