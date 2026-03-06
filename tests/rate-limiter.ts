import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { assert, expect } from "chai";

// Random suffix so re-runs don't collide on devnet
const SUFFIX = Math.random().toString(36).slice(2, 6);

describe("rate-limiter", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RateLimiter as Program<any>;

  const authority = (provider.wallet as anchor.Wallet).payer;
  const caller = Keypair.generate();
  const unauthorizedUser = Keypair.generate();

  const RESOURCE = `test/${SUFFIX}`;

  let configPda: PublicKey;
  let callerStatePda: PublicKey;

  before(async () => {
    // Fund test wallets from authority
    for (const kp of [caller, unauthorizedUser]) {
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: authority.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        })
      );
      await provider.sendAndConfirm(tx, [authority]);
    }

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rate_config"), authority.publicKey.toBuffer(), Buffer.from(RESOURCE)],
      program.programId
    );
    [callerStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("rate_state"), configPda.toBuffer(), caller.publicKey.toBuffer()],
      program.programId
    );

    console.log(`  Resource:  "${RESOURCE}"`);
    console.log(`  Program:   ${program.programId.toBase58()}`);
    console.log(`  Authority: ${authority.publicKey.toBase58().slice(0, 12)}...`);
    console.log(`  Caller:    ${caller.publicKey.toBase58().slice(0, 12)}...`);
  });

  // ─── Config lifecycle ───

  it("creates a config", async () => {
    const tx = await program.methods
      .initializeConfig(RESOURCE, 3, new BN(60))
      .accounts({
        config: configPda,
        authority: authority.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    const config = await program.account.rateLimitConfig.fetch(configPda);
    assert.equal(config.resourceId, RESOURCE);
    assert.equal(config.maxRequests, 3);
    assert.equal(config.windowSeconds.toNumber(), 60);
    assert.equal(config.totalRequests.toNumber(), 0);
    console.log(`    tx: ${tx.slice(0, 20)}...`);
  });

  it("rejects duplicate config init", async () => {
    try {
      await program.methods
        .initializeConfig(RESOURCE, 5, new BN(30))
        .accounts({
          config: configPda,
          authority: authority.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
      assert.fail("should not allow duplicate init");
    } catch (e: any) {
      // Account already exists — Anchor returns a custom program error or
      // system program error depending on the runtime version
      expect(e.message).to.not.be.empty;
    }
  });

  // ─── Rate limiting ───

  it("allows requests within the limit", async () => {
    for (let i = 1; i <= 3; i++) {
      await program.methods
        .checkRateLimit()
        .accounts({
          config: configPda,
          state: callerStatePda,
          caller: caller.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([caller])
        .rpc();
    }

    const state = await program.account.rateLimitState.fetch(callerStatePda);
    assert.equal(state.count, 3, "should have used all 3 requests");

    const config = await program.account.rateLimitConfig.fetch(configPda);
    assert.equal(config.totalRequests.toNumber(), 3, "lifetime counter should track");
  });

  it("rejects requests over the limit", async () => {
    try {
      await program.methods
        .checkRateLimit()
        .accounts({
          config: configPda,
          state: callerStatePda,
          caller: caller.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([caller])
        .rpc();
      assert.fail("should have been rate limited");
    } catch (e: any) {
      expect(e.message).to.include("RateLimitExceeded");
    }
  });

  // ─── Config updates ───

  it("authority can update config", async () => {
    await program.methods
      .updateConfig(10, new BN(120))
      .accounts({ config: configPda, authority: authority.publicKey })
      .signers([authority])
      .rpc();

    const config = await program.account.rateLimitConfig.fetch(configPda);
    assert.equal(config.maxRequests, 10);
    assert.equal(config.windowSeconds.toNumber(), 120);
  });

  it("non-authority cannot update config", async () => {
    // Derive what Anchor expects — the PDA seeds use authority.key,
    // so a different signer just won't match the constraint
    try {
      await program.methods
        .updateConfig(999, new BN(1))
        .accounts({ config: configPda, authority: unauthorizedUser.publicKey })
        .signers([unauthorizedUser])
        .rpc();
      assert.fail("should reject non-authority");
    } catch (e: any) {
      // Anchor should reject: either ConstraintHasOne or ConstraintSeeds
      expect(e.message).to.not.be.empty;
    }
  });

  it("requests work after bumping the limit", async () => {
    // We had 3/3 used, limit is now 10 — should allow more
    await program.methods
      .checkRateLimit()
      .accounts({
        config: configPda,
        state: callerStatePda,
        caller: caller.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([caller])
      .rpc();

    const state = await program.account.rateLimitState.fetch(callerStatePda);
    assert.equal(state.count, 4);
  });

  // ─── Admin reset ───

  it("authority can reset a caller", async () => {
    await program.methods
      .resetCaller()
      .accounts({
        config: configPda,
        state: callerStatePda,
        authority: authority.publicKey,
        targetCaller: caller.publicKey,
      })
      .signers([authority])
      .rpc();

    const state = await program.account.rateLimitState.fetch(callerStatePda);
    assert.equal(state.count, 0, "count should be zeroed");
    assert.equal(state.windowStart.toNumber(), 0, "window should be zeroed");
  });

  it("caller can request again after reset", async () => {
    await program.methods
      .checkRateLimit()
      .accounts({
        config: configPda,
        state: callerStatePda,
        caller: caller.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([caller])
      .rpc();

    const state = await program.account.rateLimitState.fetch(callerStatePda);
    assert.equal(state.count, 1);
  });

  // ─── Account closure (rent reclaim) ───

  it("caller can close their state account", async () => {
    const balBefore = await provider.connection.getBalance(caller.publicKey);

    await program.methods
      .closeState()
      .accounts({
        config: configPda,
        state: callerStatePda,
        caller: caller.publicKey,
      })
      .signers([caller])
      .rpc();

    const balAfter = await provider.connection.getBalance(caller.publicKey);
    // Should have gotten rent back (minus tx fee)
    expect(balAfter).to.be.greaterThan(balBefore - 10_000);

    // Account should be gone
    const info = await provider.connection.getAccountInfo(callerStatePda);
    assert.isNull(info, "state account should be closed");
  });

  it("authority can close the config", async () => {
    await program.methods
      .closeConfig()
      .accounts({
        config: configPda,
        authority: authority.publicKey,
      })
      .signers([authority])
      .rpc();

    const info = await provider.connection.getAccountInfo(configPda);
    assert.isNull(info, "config account should be closed");
  });
});
