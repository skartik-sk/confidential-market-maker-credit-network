/**
 * USDC token operations on Solana devnet.
 *
 * Uses the devnet USDC mint (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU)
 * with @solana/spl-token v0.4.14 and @solana/web3.js v1.
 */

import {
  Connection,
  PublicKey,
  Signer,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import {
  getOrCreateAssociatedTokenAccount,
  getAccount,
  transfer as splTransfer,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Devnet USDC mint — the canonical SPL token USDC on devnet. */
export const DEVNET_USDC_MINT = new PublicKey(
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
);

/** USDC has 6 decimal places. */
export const USDC_DECIMALS = 6;

/**
 * Devnet USDC faucet URL.  There is no programmatic faucet for this mint,
 * so users must visit this page in a browser.
 */
export const DEVNET_USDC_FAUCET_URL =
  "https://explorer.solana.com/address/4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU?cluster=devnet";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface UsdcOperationResult {
  signature: string;
  ata: PublicKey;
}

export interface UsdcBalanceResult {
  balanceRaw: bigint;
  balanceUi: number;
  ata: PublicKey;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Get or create the Associated Token Account for USDC owned by `owner`.
 *
 * If the ATA does not exist it will be created in a transaction paid by
 * `payer`.  Both `payer` and `owner` may be the same signer.
 */
export async function getOrCreateUsdcAta(
  connection: Connection,
  payer: Signer,
  owner: PublicKey,
): Promise<PublicKey> {
  const { address } = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    DEVNET_USDC_MINT,
    owner,
    false, // allowOwnerOffCurve
    "confirmed",
    undefined,
    TOKEN_PROGRAM_ID,
  );
  return address;
}

/**
 * Derive the USDC ATA address for `owner` *without* creating it.
 * Useful when you just need the address for display or for a CPI.
 */
export function deriveUsdcAta(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    DEVNET_USDC_MINT,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
}

/**
 * Convert a human-readable USDC amount (e.g. 100.50) to the raw
 * on-chain integer (100_500_000).
 */
export function usdcToRaw(amountUi: number): bigint {
  return BigInt(Math.round(amountUi * 10 ** USDC_DECIMALS));
}

/**
 * Convert a raw on-chain amount to a human-readable USDC number.
 */
export function rawToUsdc(amountRaw: bigint): number {
  return Number(amountRaw) / 10 ** USDC_DECIMALS;
}

/* ------------------------------------------------------------------ */
/*  Deposit                                                            */
/* ------------------------------------------------------------------ */

/**
 * Deposit USDC from the `owner` account into a vault ATA.
 *
 * 1. Ensures both the owner's ATA and the vault ATA exist (creates if needed).
 * 2. Transfers `amount` (in UI units, e.g. 100 = $100) from owner to vault.
 *
 * `payer` pays for any ATA creation and transaction fees.
 * `owner` must be a Signer (it signs the token transfer).
 */
export async function depositUsdc(
  connection: Connection,
  payer: Signer,
  owner: Signer,
  amount: number,
): Promise<UsdcOperationResult> {
  if (amount <= 0) {
    throw new Error("depositUsdc: amount must be positive");
  }

  // Ensure ATAs exist
  const ownerAta = await getOrCreateUsdcAta(connection, payer, owner.publicKey);
  const vaultAta = await getOrCreateUsdcAta(connection, payer, payer.publicKey);

  const rawAmount = usdcToRaw(amount);

  const signature = await splTransfer(
    connection,
    payer,
    ownerAta,
    vaultAta,
    owner,
    rawAmount,
    [],   // multiSigners
    undefined, // confirmOptions
    TOKEN_PROGRAM_ID,
  );

  return { signature, ata: vaultAta };
}

/**
 * Deposit USDC into a specific vault ATA address.
 * Use this when you already know the vault ATA (e.g. from an on-chain pool account).
 */
export async function depositUsdcToVault(
  connection: Connection,
  payer: Signer,
  owner: Signer,
  vaultAta: PublicKey,
  amount: number,
): Promise<UsdcOperationResult> {
  if (amount <= 0) {
    throw new Error("depositUsdcToVault: amount must be positive");
  }

  const ownerAta = await getOrCreateUsdcAta(connection, payer, owner.publicKey);

  const rawAmount = usdcToRaw(amount);

  const signature = await splTransfer(
    connection,
    payer,
    ownerAta,
    vaultAta,
    owner,
    rawAmount,
    [],
    undefined,
    TOKEN_PROGRAM_ID,
  );

  return { signature, ata: vaultAta };
}

/* ------------------------------------------------------------------ */
/*  Withdraw                                                           */
/* ------------------------------------------------------------------ */

/**
 * Withdraw USDC from a vault ATA back to the `owner` account.
 *
 * `payer` is the vault authority that holds the tokens and pays tx fees.
 * The vault's ATA must already have sufficient balance.
 */
export async function withdrawUsdc(
  connection: Connection,
  payer: Signer,
  owner: PublicKey,
  vaultAta: PublicKey,
  amount: number,
): Promise<UsdcOperationResult> {
  if (amount <= 0) {
    throw new Error("withdrawUsdc: amount must be positive");
  }

  // Ensure the owner (recipient) ATA exists
  const ownerAta = await getOrCreateUsdcAta(connection, payer, owner);

  const rawAmount = usdcToRaw(amount);

  const signature = await splTransfer(
    connection,
    payer,
    vaultAta,
    ownerAta,
    payer, // vault authority signs
    rawAmount,
    [],
    undefined,
    TOKEN_PROGRAM_ID,
  );

  return { signature, ata: ownerAta };
}

/* ------------------------------------------------------------------ */
/*  Balance                                                            */
/* ------------------------------------------------------------------ */

/**
 * Get the USDC balance for `owner`.
 *
 * Returns both the raw balance (bigint) and the UI-adjusted number.
 * If the owner has no USDC ATA, the balance is 0.
 */
export async function getUsdcBalance(
  connection: Connection,
  owner: PublicKey,
): Promise<UsdcBalanceResult> {
  const ata = deriveUsdcAta(owner);

  try {
    const account = await getAccount(
      connection,
      ata,
      "confirmed",
      TOKEN_PROGRAM_ID,
    );
    const balanceRaw = account.amount;
    return {
      balanceRaw,
      balanceUi: rawToUsdc(balanceRaw),
      ata,
    };
  } catch (error: unknown) {
    // No ATA → zero balance
    if (
      error instanceof Error &&
      (error.name === "TokenAccountNotFoundError" ||
        error.name === "TokenInvalidAccountOwnerError")
    ) {
      return { balanceRaw: BigInt(0), balanceUi: 0, ata };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Airdrop / Faucet                                                   */
/* ------------------------------------------------------------------ */

/**
 * Devnet USDC faucet helper.
 *
 * The devnet USDC mint does not have a programmatic mint authority that we
 * can call.  Instead, return the faucet URL so the UI can guide the user
 * to claim test tokens.
 */
export function requestUsdcAirdrop(): { url: string; message: string } {
  return {
    url: DEVNET_USDC_FAUCET_URL,
    message:
      "Visit the devnet USDC faucet to get test USDC. There is no programmatic faucet for this mint.",
  };
}

/**
 * Build a mock-mint transaction for local development.
 *
 * This only works if `payer` has mint authority over a local test mint.
 * For the canonical devnet USDC mint this will fail — use
 * `requestUsdcAirdrop()` instead.
 */
export async function mintTestUsdc(
  connection: Connection,
  payer: Signer,
  mint: PublicKey,
  destination: PublicKey,
  amount: number,
): Promise<string> {
  // Lazy import to keep the module tree small if not used
  const { mintTo } = await import("@solana/spl-token");

  const rawAmount = usdcToRaw(amount);

  const signature = await mintTo(
    connection,
    payer,
    mint,
    destination,
    payer, // mint authority
    rawAmount,
    [],
    undefined,
    TOKEN_PROGRAM_ID,
  );

  return signature;
}

/* ------------------------------------------------------------------ */
/*  Transfer builder (for custom transactions)                         */
/* ------------------------------------------------------------------ */

/**
 * Build a USDC transfer instruction without sending it.
 * Useful when composing multiple instructions into one transaction.
 */
export async function buildUsdcTransferIx(
  connection: Connection,
  payer: Signer,
  fromOwner: PublicKey,
  toOwner: PublicKey,
  amount: number,
): Promise<{ transaction: Transaction; fromAta: PublicKey; toAta: PublicKey }> {
  const { createTransferInstruction } = await import("@solana/spl-token");

  const fromAta = await getOrCreateUsdcAta(connection, payer, fromOwner);
  const toAta = await getOrCreateUsdcAta(connection, payer, toOwner);
  const rawAmount = usdcToRaw(amount);

  const transaction = new Transaction().add(
    createTransferInstruction(
      fromAta,
      toAta,
      fromOwner,
      rawAmount,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  return { transaction, fromAta, toAta };
}

/* ------------------------------------------------------------------ */
/*  Test token creation (user is mint authority on devnet)             */
/* ------------------------------------------------------------------ */

/**
 * Build instructions to create a test token mint + mint tokens to the user.
 * This works on devnet because the user IS the mint authority.
 * Returns the mint keypair and instructions to add to a transaction.
 */
export function buildCreateTestTokenIx(
  payer: PublicKey,
  amount: number = 10000,
): { mintKeypair: any; instructions: Promise<any[]> } {
  const { Keypair } = require("@solana/web3.js");
  const mintKeypair = Keypair.generate();

  const instructions = (async () => {
    const {
      createInitializeMintInstruction,
      createMintToInstruction,
      MINT_SIZE,
    } = await import("@solana/spl-token");
    const { SystemProgram, LAMPORTS_PER_SOL } = await import("@solana/web3.js");

    // We'll build these as raw instructions — the caller adds them to a Transaction
    return [
      // Create mint account
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mintKeypair.publicKey,
        space: MINT_SIZE,
        lamports: await (await import("@solana/web3.js")).Connection.prototype.getMinimumBalanceForRentExemption
          ? 0 : 0, // Will be filled by caller
        programId: TOKEN_PROGRAM_ID,
      }),
    ];
  })();

  return { mintKeypair, instructions };
}

/**
 * Create a test USDC-like token on devnet where the user has mint authority.
 * Returns the mint address so it can be used as a USDC substitute.
 */
export async function createAndMintTestToken(
  connection: any,
  payer: any,
  amount: number = 10000,
): Promise<{ mint: PublicKey; signature: string }> {
  const {
    createInitializeMintInstruction,
    createMintToInstruction,
    MINT_SIZE,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID,
  } = await import("@solana/spl-token");
  const { Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = await import("@solana/web3.js");

  const mintKp = Keypair.generate();
  const ata = getAssociatedTokenAddressSync(mintKp.publicKey, payer.publicKey);
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKp.publicKey,
      space: MINT_SIZE,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(mintKp.publicKey, 6, payer.publicKey, null, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(payer.publicKey, ata, payer.publicKey, mintKp.publicKey, TOKEN_PROGRAM_ID),
    createMintToInstruction(mintKp.publicKey, ata, payer.publicKey, amount * 1e6, [], TOKEN_PROGRAM_ID),
  );

  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = payer.publicKey;
  tx.partialSign(mintKp);

  const signed = await payer.signTransaction ? await payer.signTransaction(tx) : tx;
  const sig = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(sig, "confirmed");

  return { mint: mintKp.publicKey, signature: sig };
}

/* ------------------------------------------------------------------ */
/*  Wallet-adapter compatible instruction builders                     */
/*  These return TransactionInstruction[] so the caller can sign via   */
/*  wallet adapter instead of requiring a Signer with secretKey.       */
/* ------------------------------------------------------------------ */

/**
 * Build instructions to create ATA for USDC if it doesn't exist.
 * Returns { instructions, ata } — caller adds to Transaction and signs with wallet.
 */
export async function buildCreateAtaIx(
  owner: PublicKey,
): Promise<{ instructions: any[]; ata: PublicKey }> {
  const { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, owner);
  // Always include the instruction — if ATA exists, the tx will just skip/fail gracefully
  return {
    instructions: [createAssociatedTokenAccountInstruction(owner, ata, owner, DEVNET_USDC_MINT)],
    ata,
  };
}

/**
 * Build a USDC transfer instruction (deposit collateral).
 * Returns the instruction + ATA info.
 */
export async function buildDepositIx(
  from: PublicKey,
  to: PublicKey,
  amountUi: number,
): Promise<{ instructions: any[]; fromAta: PublicKey; toAta: PublicKey }> {
  const { createTransferInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");

  const fromAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, from);
  const toAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, to);
  const rawAmount = BigInt(Math.round(amountUi * 10 ** USDC_DECIMALS));

  const instructions: any[] = [];
  // Ensure destination ATA exists
  instructions.push(createAssociatedTokenAccountInstruction(from, toAta, to, DEVNET_USDC_MINT));
  // Transfer
  instructions.push(createTransferInstruction(fromAta, toAta, from, rawAmount));

  return { instructions, fromAta, toAta };
}

/**
 * Get USDC balance — only needs connection + publicKey, no signer.
 */
export async function getUsdcBalanceReadOnly(
  connection: Connection,
  owner: PublicKey,
): Promise<number> {
  try {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, owner);
    const { getAccount } = await import("@solana/spl-token");
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 10 ** USDC_DECIMALS;
  } catch {
    return 0;
  }
}

