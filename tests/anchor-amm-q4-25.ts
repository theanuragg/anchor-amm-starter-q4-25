import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorAmmQ425 } from "../target/types/anchor_amm_q4_25";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import BN from "bn.js";

describe("anchor-amm-q4-25", () => {
  // Configure the client to use the local cluster
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorAmmQ425 as Program<AnchorAmmQ425>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Test keypairs
  let mintX: PublicKey;
  let mintY: PublicKey;
  let mintAuthority: Keypair;
  let user: Keypair;

  // PDAs and derived accounts
  let config: PublicKey;
  let mintLp: PublicKey;
  let vaultX: PublicKey;
  let vaultY: PublicKey;
  let userAtaX: PublicKey;
  let userAtaY: PublicKey;
  let userAtaLp: PublicKey;

  const seed = new BN(1);
  const fee = 100; // 1% fee (100 basis points)

  // Helper to derive PDAs
  async function deriveAccounts() {
    [config] = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [mintLp] = PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), config.toBuffer()],
      program.programId
    );

    vaultX = await getAssociatedTokenAddress(mintX, config, true);
    vaultY = await getAssociatedTokenAddress(mintY, config, true);
  }

  before(async () => {
    // Create mint authority and user
    mintAuthority = Keypair.generate();
    user = Keypair.generate();

    // Airdrop SOL to accounts
    const airdropSigs = await Promise.all([
      connection.requestAirdrop(mintAuthority.publicKey, 10 * LAMPORTS_PER_SOL),
      connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL),
    ]);

    await Promise.all(
      airdropSigs.map((sig) => connection.confirmTransaction(sig))
    );

    // Create token mints
    mintX = await createMint(
      connection,
      payer,
      mintAuthority.publicKey,
      null,
      6
    );
    mintY = await createMint(
      connection,
      payer,
      mintAuthority.publicKey,
      null,
      6
    );

    // Derive PDAs
    await deriveAccounts();

    // Create user token accounts
    userAtaX = await createAssociatedTokenAccount(
      connection,
      payer,
      mintX,
      user.publicKey
    );
    userAtaY = await createAssociatedTokenAccount(
      connection,
      payer,
      mintY,
      user.publicKey
    );

    // Mint tokens to user (1000 each)
    const mintAmount = 1_000_000_000; // 1000 tokens with 6 decimals
    await mintTo(
      connection,
      payer,
      mintX,
      userAtaX,
      mintAuthority,
      mintAmount
    );
    await mintTo(
      connection,
      payer,
      mintY,
      userAtaY,
      mintAuthority,
      mintAmount
    );

    // Derive user LP ATA (will be created during deposit)
    userAtaLp = await getAssociatedTokenAddress(mintLp, user.publicKey);
  });

  describe("Initialize Pool", () => {
    it("initializes the AMM pool", async () => {
      const tx = await program.methods
        .initialize(seed, fee, null)
        .accounts({
          initializer: payer.publicKey,
          mintX,
          mintY,
          mintLp,
          vaultX,
          vaultY,
          config,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Initialize tx:", tx);

      // Verify config account
      const configAccount = await program.account.config.fetch(config);
      expect(configAccount.seed.toString()).to.equal(seed.toString());
      expect(configAccount.fee).to.equal(fee);
      expect(configAccount.locked).to.equal(false);
      expect(configAccount.mintX.toBase58()).to.equal(mintX.toBase58());
      expect(configAccount.mintY.toBase58()).to.equal(mintY.toBase58());
    });
  });

  describe("Deposit Liquidity", () => {
    it("deposits initial liquidity", async () => {
      const depositAmount = new BN(100_000_000); // 100 LP tokens
      const maxX = new BN(100_000_000); // 100 tokens X
      const maxY = new BN(100_000_000); // 100 tokens Y

      const tx = await program.methods
        .deposit(depositAmount, maxX, maxY)
        .accounts({
          user: user.publicKey,
          mintX,
          mintY,
          config,
          mintLp,
          vaultX,
          vaultY,
          userX: userAtaX,
          userY: userAtaY,
          userLp: userAtaLp,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log("Initial deposit tx:", tx);

      // Verify vault balances
      const vaultXAccount = await getAccount(connection, vaultX);
      const vaultYAccount = await getAccount(connection, vaultY);
      expect(Number(vaultXAccount.amount)).to.equal(100_000_000);
      expect(Number(vaultYAccount.amount)).to.equal(100_000_000);

      // Verify user received LP tokens
      const userLpAccount = await getAccount(connection, userAtaLp);
      expect(Number(userLpAccount.amount)).to.equal(100_000_000);
    });

    it("deposits subsequent liquidity respecting ratio", async () => {
      const depositAmount = new BN(50_000_000); // 50 LP tokens
      const maxX = new BN(100_000_000); // Allow up to 100 X
      const maxY = new BN(100_000_000); // Allow up to 100 Y

      const vaultXBefore = await getAccount(connection, vaultX);
      const vaultYBefore = await getAccount(connection, vaultY);

      const tx = await program.methods
        .deposit(depositAmount, maxX, maxY)
        .accounts({
          user: user.publicKey,
          mintX,
          mintY,
          config,
          mintLp,
          vaultX,
          vaultY,
          userX: userAtaX,
          userY: userAtaY,
          userLp: userAtaLp,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      console.log("Subsequent deposit tx:", tx);

      // Verify vault balances increased proportionally
      const vaultXAfter = await getAccount(connection, vaultX);
      const vaultYAfter = await getAccount(connection, vaultY);
      expect(Number(vaultXAfter.amount)).to.be.greaterThan(
        Number(vaultXBefore.amount)
      );
      expect(Number(vaultYAfter.amount)).to.be.greaterThan(
        Number(vaultYBefore.amount)
      );
    });
  });

  describe("Swap", () => {
    it("swaps X for Y", async () => {
      const swapAmount = new BN(10_000_000); // 10 tokens
      const minOut = new BN(1); // Accept any output for this test

      const userYBefore = await getAccount(connection, userAtaY);

      const tx = await program.methods
        .swap(true, swapAmount, minOut)
        .accounts({
          user: user.publicKey,
          mintX,
          mintY,
          config,
          vaultX,
          vaultY,
          userX: userAtaX,
          userY: userAtaY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("Swap X->Y tx:", tx);

      // Verify user received Y tokens
      const userYAfter = await getAccount(connection, userAtaY);
      expect(Number(userYAfter.amount)).to.be.greaterThan(
        Number(userYBefore.amount)
      );
    });

    it("swaps Y for X", async () => {
      const swapAmount = new BN(10_000_000); // 10 tokens
      const minOut = new BN(1); // Accept any output for this test

      const userXBefore = await getAccount(connection, userAtaX);

      const tx = await program.methods
        .swap(false, swapAmount, minOut)
        .accounts({
          user: user.publicKey,
          mintX,
          mintY,
          config,
          vaultX,
          vaultY,
          userX: userAtaX,
          userY: userAtaY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("Swap Y->X tx:", tx);

      // Verify user received X tokens
      const userXAfter = await getAccount(connection, userAtaX);
      expect(Number(userXAfter.amount)).to.be.greaterThan(
        Number(userXBefore.amount)
      );
    });
  });

  describe("Withdraw Liquidity", () => {
    it("withdraws liquidity by burning LP tokens", async () => {
      const withdrawAmount = new BN(50_000_000); // 50 LP tokens
      const minX = new BN(1); // Accept any output
      const minY = new BN(1); // Accept any output

      const userXBefore = await getAccount(connection, userAtaX);
      const userYBefore = await getAccount(connection, userAtaY);
      const userLpBefore = await getAccount(connection, userAtaLp);

      const tx = await program.methods
        .withdraw(withdrawAmount, minX, minY)
        .accounts({
          user: user.publicKey,
          mintX,
          mintY,
          config,
          mintLp,
          vaultX,
          vaultY,
          userX: userAtaX,
          userY: userAtaY,
          userLp: userAtaLp,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      console.log("Withdraw tx:", tx);

      // Verify user received tokens back
      const userXAfter = await getAccount(connection, userAtaX);
      const userYAfter = await getAccount(connection, userAtaY);
      const userLpAfter = await getAccount(connection, userAtaLp);

      expect(Number(userXAfter.amount)).to.be.greaterThan(
        Number(userXBefore.amount)
      );
      expect(Number(userYAfter.amount)).to.be.greaterThan(
        Number(userYBefore.amount)
      );
      expect(Number(userLpAfter.amount)).to.equal(
        Number(userLpBefore.amount) - 50_000_000
      );
    });
  });

  describe("Error Cases", () => {
    it("fails swap when slippage exceeded", async () => {
      const swapAmount = new BN(10_000_000);
      const minOut = new BN(100_000_000_000); // Unrealistic minimum output

      try {
        await program.methods
          .swap(true, swapAmount, minOut)
          .accounts({
            user: user.publicKey,
            mintX,
            mintY,
            config,
            vaultX,
            vaultY,
            userX: userAtaX,
            userY: userAtaY,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with slippage error");
      } catch (err: any) {
        expect(err.toString()).to.include("SlippageExceeded");
      }
    });

    it("fails deposit with zero amount", async () => {
      const depositAmount = new BN(0);
      const maxX = new BN(100_000_000);
      const maxY = new BN(100_000_000);

      try {
        await program.methods
          .deposit(depositAmount, maxX, maxY)
          .accounts({
            user: user.publicKey,
            mintX,
            mintY,
            config,
            mintLp,
            vaultX,
            vaultY,
            userX: userAtaX,
            userY: userAtaY,
            userLp: userAtaLp,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with invalid amount error");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidAmount");
      }
    });
  });
});
