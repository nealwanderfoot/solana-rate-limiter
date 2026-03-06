#!/usr/bin/env npx ts-node

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, clusterApiUrl } from "@solana/web3.js";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";

const IDL_PATH = path.join(__dirname, "../target/idl/rate_limiter.json");

function loadIdl() {
  if (!fs.existsSync(IDL_PATH)) {
    console.error("IDL not found — run `anchor build` first.");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
}

const idl = loadIdl();
const PROGRAM_ID = new PublicKey(idl.address);

function getProvider(opts: { keypair?: string; cluster?: string }) {
  const cluster = opts.cluster || "devnet";
  const rpcUrl = cluster.startsWith("http") ? cluster : clusterApiUrl(cluster as any);
  const connection = new Connection(rpcUrl, "confirmed");

  const kpPath = opts.keypair || `${process.env.HOME}/.config/solana/id.json`;
  if (!fs.existsSync(kpPath)) {
    console.error(`Keypair not found at ${kpPath}`);
    console.error("Generate one: solana-keygen new");
    process.exit(1);
  }

  const kpData = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(new Uint8Array(kpData));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return { provider, keypair, cluster };
}

function getProgram(provider: anchor.AnchorProvider) {
  return new Program(idl, provider);
}

function configPda(authority: PublicKey, resourceId: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rate_config"), authority.toBuffer(), Buffer.from(resourceId)],
    PROGRAM_ID
  );
}

function statePda(config: PublicKey, caller: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rate_state"), config.toBuffer(), caller.toBuffer()],
    PROGRAM_ID
  );
}

function explorerUrl(sig: string, cluster: string) {
  const suffix = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`;
  return `https://explorer.solana.com/tx/${sig}${suffix}`;
}

const cli = new Command();

cli
  .name("rate-limiter")
  .description("CLI for the on-chain Solana rate limiter")
  .version("1.0.0")
  .option("-k, --keypair <path>", "path to Solana keypair JSON")
  .option("-c, --cluster <url>", "cluster: devnet | mainnet-beta | <rpc url>", "devnet");

cli
  .command("init")
  .description("Create a rate limit config for a resource")
  .requiredOption("-r, --resource <id>", "resource name (e.g. api/mint)")
  .requiredOption("-m, --max <n>", "max requests per window", parseInt)
  .requiredOption("-w, --window <sec>", "window size in seconds", parseInt)
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair, cluster } = getProvider(globals);
    const prog = getProgram(provider);
    const [pda] = configPda(keypair.publicKey, opts.resource);

    console.log(`Creating config for "${opts.resource}" (${opts.max} req / ${opts.window}s)`);
    const sig = await prog.methods
      .initializeConfig(opts.resource, opts.max, new anchor.BN(opts.window))
      .accounts({
        config: pda,
        authority: keypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    console.log(`✅ Created → ${explorerUrl(sig, cluster)}`);
    console.log(`   Config PDA: ${pda.toBase58()}`);
  });

cli
  .command("check")
  .description("Consume one request against a rate limit")
  .requiredOption("-r, --resource <id>", "resource name")
  .requiredOption("-a, --authority <pubkey>", "config authority pubkey")
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair, cluster } = getProvider(globals);
    const prog = getProgram(provider);

    const auth = new PublicKey(opts.authority);
    const [cfgPda] = configPda(auth, opts.resource);
    const [stPda] = statePda(cfgPda, keypair.publicKey);

    try {
      const sig = await prog.methods
        .checkRateLimit()
        .accounts({
          config: cfgPda,
          state: stPda,
          caller: keypair.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

      const st = await prog.account.rateLimitState.fetch(stPda);
      const cfg = await prog.account.rateLimitConfig.fetch(cfgPda);
      console.log(`✅ Allowed (${st.count}/${cfg.maxRequests}) → ${explorerUrl(sig, cluster)}`);
    } catch (e: any) {
      if (e.message?.includes("RateLimitExceeded")) {
        console.log("🚫 Rate limited. Try again later.");
        process.exit(1);
      }
      throw e;
    }
  });

cli
  .command("status")
  .description("View rate limit status for a caller")
  .requiredOption("-r, --resource <id>", "resource name")
  .requiredOption("-a, --authority <pubkey>", "config authority pubkey")
  .option("--caller <pubkey>", "check a specific caller (default: your wallet)")
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair } = getProvider(globals);
    const prog = getProgram(provider);

    const auth = new PublicKey(opts.authority);
    const callerKey = opts.caller ? new PublicKey(opts.caller) : keypair.publicKey;
    const [cfgPda] = configPda(auth, opts.resource);
    const [stPda] = statePda(cfgPda, callerKey);

    const cfg = await prog.account.rateLimitConfig.fetch(cfgPda).catch(() => null);
    if (!cfg) {
      console.log("Config not found. Create it with `init` first.");
      process.exit(1);
    }

    console.log(`\n  Resource:    ${cfg.resourceId}`);
    console.log(`  Limit:       ${cfg.maxRequests} req / ${cfg.windowSeconds}s`);
    console.log(`  Total reqs:  ${cfg.totalRequests} (lifetime)`);

    const st = await prog.account.rateLimitState.fetch(stPda).catch(() => null);
    if (st) {
      const now = Math.floor(Date.now() / 1000);
      const resetsIn = st.windowStart.toNumber() + cfg.windowSeconds.toNumber() - now;
      console.log(`\n  Caller:      ${callerKey.toBase58()}`);
      console.log(`  Used:        ${st.count} / ${cfg.maxRequests}`);
      console.log(`  Remaining:   ${cfg.maxRequests - st.count}`);
      console.log(`  Resets in:   ${resetsIn > 0 ? resetsIn + "s" : "expired (will reset on next call)"}`);
    } else {
      console.log(`\n  No state for this caller yet.`);
    }
  });

cli
  .command("update")
  .description("Update config parameters (authority only)")
  .requiredOption("-r, --resource <id>", "resource name")
  .requiredOption("-m, --max <n>", "new max requests", parseInt)
  .requiredOption("-w, --window <sec>", "new window in seconds", parseInt)
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair, cluster } = getProvider(globals);
    const prog = getProgram(provider);
    const [pda] = configPda(keypair.publicKey, opts.resource);

    const sig = await prog.methods
      .updateConfig(opts.max, new anchor.BN(opts.window))
      .accounts({ config: pda, authority: keypair.publicKey })
      .rpc();

    console.log(`✅ Updated → ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("reset")
  .description("Reset a caller's rate limit state (authority only)")
  .requiredOption("-r, --resource <id>", "resource name")
  .requiredOption("--target <pubkey>", "caller pubkey to reset")
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair, cluster } = getProvider(globals);
    const prog = getProgram(provider);

    const [cfgPda] = configPda(keypair.publicKey, opts.resource);
    const targetKey = new PublicKey(opts.target);
    const [stPda] = statePda(cfgPda, targetKey);

    const sig = await prog.methods
      .resetCaller()
      .accounts({
        config: cfgPda,
        state: stPda,
        authority: keypair.publicKey,
        targetCaller: targetKey,
      })
      .rpc();

    console.log(`✅ Reset ${targetKey.toBase58().slice(0, 12)}... → ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("close-config")
  .description("Close a config account and reclaim rent (authority only)")
  .requiredOption("-r, --resource <id>", "resource name")
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair, cluster } = getProvider(globals);
    const prog = getProgram(provider);
    const [pda] = configPda(keypair.publicKey, opts.resource);

    const sig = await prog.methods
      .closeConfig()
      .accounts({ config: pda, authority: keypair.publicKey })
      .rpc();

    console.log(`✅ Config closed, rent reclaimed → ${explorerUrl(sig, cluster)}`);
  });

cli
  .command("close-state")
  .description("Close your state account and reclaim rent")
  .requiredOption("-r, --resource <id>", "resource name")
  .requiredOption("-a, --authority <pubkey>", "config authority pubkey")
  .action(async (opts, cmd) => {
    const globals = cmd.parent.opts();
    const { provider, keypair, cluster } = getProvider(globals);
    const prog = getProgram(provider);

    const auth = new PublicKey(opts.authority);
    const [cfgPda] = configPda(auth, opts.resource);
    const [stPda] = statePda(cfgPda, keypair.publicKey);

    const sig = await prog.methods
      .closeState()
      .accounts({ config: cfgPda, state: stPda, caller: keypair.publicKey })
      .rpc();

    console.log(`✅ State closed, rent reclaimed → ${explorerUrl(sig, cluster)}`);
  });

cli.parseAsync(process.argv);
