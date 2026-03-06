# solana-rate-limiter

An on-chain rate limiter for Solana, built with [Anchor](https://www.anchor-lang.com/).

The idea: take something every backend developer has built a dozen times (rate limiting with Redis, middleware, API gateways) and implement it as a Solana program. Not because you *should* rate-limit on-chain in production — the economics don't make sense for most use cases — but because the exercise reveals interesting things about how Solana's account model maps to patterns we take for granted in Web2.

**Devnet Program:** [`7mF84Hg6TAS48ZffjC1mqWydj96rcgUMuo3RvcJymbka`](https://explorer.solana.com/address/7mF84Hg6TAS48ZffjC1mqWydj96rcgUMuo3RvcJymbka?cluster=devnet)

## How it works

An authority creates a **config** for a named resource (like `"api/mint"`) specifying the limit and window size. When a caller wants to consume a request, they call `check_rate_limit`. The program either increments their counter and returns success, or rejects with `RateLimitExceeded`.

Each caller gets their own **state account** (created automatically on first use). State tracks how many requests they've made in the current window. When the window expires, the counter resets on the next call.

```
                    ┌──────────────────────┐
                    │   RateLimitConfig     │  One per resource.
                    │   PDA: [rate_config,  │  Authority controls it.
                    │    authority, name]   │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
     │ RateLimitState │ │ RateLimitState │ │ RateLimitState │
     │ PDA: [rate_    │ │ PDA: [rate_    │ │ PDA: [rate_    │
     │ state, config, │ │ state, config, │ │ state, config, │
     │ caller_A]      │ │ caller_B]      │ │ caller_C]      │
     │                │ │                │ │                │
     │ count: 3/10    │ │ count: 7/10    │ │ count: 0/10    │
     └────────────────┘ └────────────────┘ └────────────────┘
```

### Instructions

| Instruction | Who calls it | What it does |
|---|---|---|
| `initialize_config` | Authority | Creates a rate limit rule for a resource |
| `check_rate_limit` | Anyone | Consumes one request (or fails if over limit) |
| `update_config` | Authority | Changes max_requests / window_seconds |
| `reset_caller` | Authority | Zeroes out a specific caller's state |
| `close_config` | Authority | Closes config account, reclaims rent |
| `close_state` | Caller | Closes own state account, reclaims rent |

## The Web2 version

In a typical backend, rate limiting looks something like:

```
INCR   rate:{user}:{resource}
EXPIRE rate:{user}:{resource} {window}
if count > limit → 429
```

Redis handles the TTL. Identity comes from a JWT or API key. The server enforces everything. State is ephemeral — restart Redis and counters reset. Config is an env var or a row in Postgres.

## What changes on Solana

Some things map cleanly:

- `rate:{user}:{resource}` → PDA seeded by `[config_pubkey, caller_pubkey]`
- Atomic `INCR` → single instruction (atomic by default on Solana)
- Admin config → on-chain account, gated by `has_one = authority`

Some things don't:

- **No TTL.** Redis expires keys automatically. On Solana, the program has to check `Clock::unix_timestamp` on every call and decide whether to reset the counter. It works, but it's manual.
- **Caller pays rent.** Each new caller's state account costs ~0.002 SOL in rent-exempt lamports. In Redis, a new key costs nothing. This is the biggest economic difference — it means the rate limiter has an inherent cost-per-unique-caller. (We added `close_state` so callers can reclaim this.)
- **No sliding window.** A proper sliding window (like Redis sorted sets) would need multiple accounts or a circular buffer. We went with fixed windows — simpler, and honestly good enough for most use cases.
- **Identity is free.** This is the one place Solana wins cleanly. In Web2 you need auth middleware to verify who's calling. On Solana, the caller's pubkey is cryptographically proven by their signature. No JWTs, no API key management, no trust.

### Tradeoffs

| | Redis | Solana |
|---|---|---|
| Cost per check | ~free | ~0.000005 SOL tx fee |
| Cost per new caller | Free | ~0.002 SOL rent (reclaimable) |
| Window types | Sliding, fixed, token bucket | Fixed only (without getting complex) |
| State durability | Ephemeral (or AOF/RDB) | Permanent, on-chain |
| Config updates | Instant | ~400ms (one transaction) |
| Composability | SDK/API call | CPI from any Solana program |
| Caller identity | Trust-based (JWT/key) | Cryptographic (signature) |

### Where this actually makes sense

Honestly? Not many places. The cost-per-caller rent makes this impractical as a general-purpose rate limiter. But there are niches:

- **On-chain protocol governance.** Rate-limit proposal submissions per wallet.
- **NFT minting.** Cap mints per wallet per time window, enforced at the program level.
- **Composable middleware.** Other programs CPI into `check_rate_limit` to gate their own instructions without reimplementing the logic.

## Quick start

### Prerequisites

- Rust + Anchor (`avm install latest && avm use latest`)
- Solana CLI, configured for devnet
- Node.js ≥ 18

### Build & deploy

```bash
git clone https://github.com/nealwanderfoot/solana-rate-limiter.git
cd solana-rate-limiter
yarn install
anchor build
anchor deploy --provider.cluster devnet
```

### Run tests

```bash
anchor test --skip-local-validator --skip-deploy
```

### CLI

```bash
# Create a config: 10 requests per 60 seconds
yarn cli init -r "api/mint" -m 10 -w 60

# Consume a request
yarn cli check -r "api/mint" -a <YOUR_PUBKEY>

# Check status
yarn cli status -r "api/mint" -a <YOUR_PUBKEY>

# Update limits
yarn cli update -r "api/mint" -m 20 -w 120

# Reset a caller (admin)
yarn cli reset -r "api/mint" --target <CALLER_PUBKEY>

# Close your state account and get rent back
yarn cli close-state -r "api/mint" -a <AUTHORITY_PUBKEY>

# Close config entirely (admin)
yarn cli close-config -r "api/mint"
```

Use `--cluster mainnet-beta` or `--cluster <rpc-url>` to target other networks.

## Devnet transactions

- **Deploy (upgrade):** [`3RRBFE9...`](https://explorer.solana.com/tx/3RRBFE91DZTi2P9ESKqnf3gT72ULoCrFGF9BhEGbGbGx1GoAfvwxeMCEqZAThs2s326CZERNJHiuxDHizLeSmR98?cluster=devnet)
- **Initial deploy:** [`5oeDWAh...`](https://explorer.solana.com/tx/5oeDWAhwmkSzJedmUNguWtPTFHGVQi3eWQgwr61gBgw5u7DCD4CJGdVqryfPgkcRc6xp7VrYs19u7trd5DE1SjYH?cluster=devnet)
- **initialize_config:** [`2Daq3SA...`](https://explorer.solana.com/tx/2Daq3SADSNLS2TYFDApuVGMyMiBpMxv5hZwmGEWC7jmhLUHeGG1KUtSGAhkK1ADVoNh46gau5xr4M6ojyX3D9hav?cluster=devnet)
- **check_rate_limit:** [`2HmtPik...`](https://explorer.solana.com/tx/2HmtPikv44EDsEopTnV52PAttbDuh21TCCBYQX4r7dqJLHCfmSzCtfGgsY6dGpdh227jYAHZSEvJpEBTuTSFNAoE?cluster=devnet)
- **update_config:** [`2NCYPWG...`](https://explorer.solana.com/tx/2NCYPWGVPRNU8Cbx5yBE3CjxhcTpVLoHaBzxRbidWyQe7Nik1fTq5WcypXVeP7E5d4rVadY768aBJpiZiWMmHozh?cluster=devnet)

## Project structure

```
programs/rate-limiter/src/lib.rs   ← the program (Anchor/Rust)
tests/rate-limiter.ts              ← integration tests
app/cli.ts                         ← CLI client
```

## Limitations

- **Fixed windows only.** A sliding window would need a more complex data structure (circular buffer across multiple accounts, or a sorted set emulated with PDAs). Not worth the complexity for this scope.
- **No pause/unpause.** You can set `max_requests` to 0 via `update_config`, but there's no dedicated pause flag. The padding field in the config account reserves space for adding this later.
- **`init_if_needed` risk.** The state account uses Anchor's `init_if_needed`, which has known re-initialization concerns. We mitigate this with an `initialized` flag and deterministic PDA seeds — the state can only be created for the correct (config, caller) pair. But it's worth calling out.
- **Clock drift.** `Clock::unix_timestamp` is validator-reported and can drift by a few seconds. For rate limiting purposes this is fine, but don't use this for anything that needs sub-second precision.

## License

MIT
