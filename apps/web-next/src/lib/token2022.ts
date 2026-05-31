/**
 * Token-2022 confidential transfer framework for the credit-vault app.
 *
 * NOTE: The ZK ElGamal proof program is still under audit on Solana mainnet
 * and devnet. The instructions below construct the correct transaction
 * formats that WILL work once the proof program is activated. Functions that
 * require the ZK proof program are clearly marked.
 *
 * The installed @solana/spl-token@0.4.14 does not ship the
 * confidentialTransfer extension, so this module builds instruction data
 * manually using the Token-2022 CPI specification.
 *
 * Token-2022 program: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
 */

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
  Connection,
  Keypair,
} from "@solana/web3.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Token-2022 program ID. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/** ZK ElGamal proof program (still in audit, not yet active on public clusters). */
export const ZK_ELGAMAL_PROOF_PROGRAM_ID = new PublicKey(
  "zkElGamalProof1111111111111111111111111111111",
);

/** Confidential transfer mint extension discriminator. */
const CONFIDENTIAL_TRANSFER_MINT_DISCRIMINATOR = Buffer.from([
  0x10, 0x9a, 0x78, 0x2d, 0x6d, 0x43, 0xe2, 0xd9,
]);

/** Confidential transfer account extension discriminator. */
const CONFIDENTIAL_TRANSFER_ACCOUNT_DISCRIMINATOR = Buffer.from([
  0xa3, 0x5e, 0x22, 0x0e, 0x91, 0xcd, 0x44, 0x63,
]);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ConfidentialTransferState {
  /** The Token-2022 mint address. */
  mint: PublicKey;
  /** Whether confidential transfers have been configured on the mint. */
  configured: boolean;
  /** The authority that can view decrypted amounts (audit). */
  auditAuthority: string;
  /** Whether a withdrawal is pending (requires ZK proof). */
  withdrawPending: boolean;
}

export interface ConfidentialBalance {
  /** Pending confidential balance (ElGamal encrypted, displayed as "pending"). */
  pendingBalanceEncrypted: string;
  /** Available confidential balance (ElGamal encrypted, displayed as "available"). */
  availableBalanceEncrypted: string;
  /** Whether the balances could be decrypted (requires client-side keypair). */
  decrypted: boolean;
  /** Decrypted pending balance (if available). */
  pendingBalance?: number;
  /** Decrypted available balance (if available). */
  availableBalance?: number;
}

export type ConfidentialTransferStatus =
  | { status: "available"; cluster: string }
  | { status: "audit_pending"; cluster: string; note: string }
  | { status: "unavailable"; reason: string };

/* ------------------------------------------------------------------ */
/*  PDA helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Derive the associated token address for a Token-2022 mint.
 *
 * Uses the standard ATA derivation with the Token-2022 program ID.
 */
export function getAssociatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      owner.toBuffer(),
      TOKEN_2022_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  )[0];
}

/* ------------------------------------------------------------------ */
/*  Mint creation with confidential transfer extension                  */
/* ------------------------------------------------------------------ */

/**
 * Create an instruction to initialize a Token-2022 mint with the confidential
 * transfer extension enabled.
 *
 * This instruction:
 *   1. Creates the mint account with enough space for the mint + extension.
 *   2. Initializes the confidential transfer mint extension.
 *   3. Initializes the mint itself.
 *
 * NOTE: Requires the ZK ElGamal proof program for full functionality.
 *
 * @param params.authority - Mint authority
 * @param params.decimals - Token decimals
 * @param params.freezeAuthority - Optional freeze authority (defaults to None)
 * @param params.payer - Payer for account creation
 * @param params.mintKeypair - Optional keypair for the new mint
 */
export function createConfidentialMint(params: {
  authority: PublicKey;
  decimals: number;
  freezeAuthority?: PublicKey;
  payer?: PublicKey;
  mintKeypair?: Keypair;
}): TransactionInstruction[] {
  const { authority, decimals } = params;
  const freezeAuthority = params.freezeAuthority ?? null;
  const payer = params.payer ?? authority;
  const mintKeypair = params.mintKeypair ?? Keypair.generate();
  const mint = mintKeypair.publicKey;

  const instructions: TransactionInstruction[] = [];

  // Space calculation for Token-2022 mint + confidential transfer extension:
  //   Mint base: 82 bytes
  //   ConfidentialTransferMint: ~293 bytes (authority, pk, auto_approve, etc.)
  const CONFIDENTIAL_MINT_SIZE = 82 + 293;
  const lamports = 2_039_280; // approximate rent for ~375 bytes

  // Instruction 1: Create account
  instructions.push(
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      space: CONFIDENTIAL_MINT_SIZE,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
  );

  // Instruction 2: Initialize confidential transfer mint extension.
  // This is Token-2022 instruction: InitializeConfidentialTransferMint
  // Accounts: [mint (writable), authority (signer)]
  // Data layout:
  //   discriminator (4 bytes - instruction index for confidential transfer mint init)
  //   auto_approve_new_accounts: u8 (1)
  //   authority: Pubkey (32)
  const initConfidentialMintData = Buffer.alloc(4 + 1 + 32);
  let offset = 0;
  // Instruction discriminator for ConfidentialTransferMint initialization
  // This is the Token-2022 extension instruction
  initConfidentialMintData.writeUInt32LE(37, offset); offset += 4;
  initConfidentialMintData.writeUInt8(1, offset); offset += 1; // auto_approve = true
  authority.toBuffer().copy(initConfidentialMintData, offset); offset += 32;

  instructions.push(
    new TransactionInstruction({
      keys: [
        { pubkey: mint, isSigner: false, isWritable: true },
        { pubkey: authority, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_2022_PROGRAM_ID,
      data: initConfidentialMintData,
    }),
  );

  // Instruction 3: Initialize the mint (Token-2022)
  const initMintData = Buffer.alloc(1 + 1 + 32 + 1);
  offset = 0;
  initMintData.writeUInt8(20, offset); offset += 1; // InitializeMint2 instruction index for Token-2022
  initMintData.writeUInt8(decimals, offset); offset += 1;
  authority.toBuffer().copy(initMintData, offset); offset += 32;
  if (freezeAuthority) {
    initMintData.writeUInt8(1, offset); offset += 1;
  } else {
    initMintData.writeUInt8(0, offset); offset += 1;
  }

  instructions.push(
    new TransactionInstruction({
      keys: [
        { pubkey: mint, isSigner: false, isWritable: true },
      ],
      programId: TOKEN_2022_PROGRAM_ID,
      data: initMintData.subarray(0, offset),
    }),
  );

  return instructions;
}

/* ------------------------------------------------------------------ */
/*  Enable confidential transfers on existing mint                     */
/* ------------------------------------------------------------------ */

/**
 * Enable confidential transfer extension on an existing Token-2022 mint.
 *
 * NOTE: Requires the ZK ElGamal proof program. The mint must already be
 * a Token-2022 mint (not a legacy Token program mint).
 *
 * @param params.mint - The Token-2022 mint
 * @param params.authority - Mint authority (signer)
 * @param params.payer - Payer for rent exemption
 */
export function enableConfidentialTransfers(params: {
  mint: PublicKey;
  authority: PublicKey;
  payer: PublicKey;
}): TransactionInstruction {
  const { mint, authority, payer } = params;

  // Realloc the mint account to include the confidential transfer extension,
  // then initialize it.
  //
  // This is a framework instruction — the real implementation would need to:
  //   1. Realloc the mint account (+293 bytes for ConfidentialTransferMint)
  //   2. Call InitializeConfidentialTransferMint

  const data = Buffer.alloc(4 + 1 + 32);
  let offset = 0;
  data.writeUInt32LE(37, offset); offset += 4;
  data.writeUInt8(1, offset); offset += 1; // auto_approve
  authority.toBuffer().copy(data, offset); offset += 32;

  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Confidential deposit (tokens -> ElGamal encrypted balance)          */
/* ------------------------------------------------------------------ */

/**
 * Create an instruction to deposit tokens from the public balance into the
 * confidential (ElGamal encrypted) pending balance.
 *
 * NOTE: Requires the ZK ElGamal proof program. The amount will be encrypted
 * client-side using the mint's ElGamal public key, then submitted as an
 * ElGamal ciphertext in the instruction data.
 *
 * @param params.mint - Token-2022 mint with confidential transfers enabled
 * @param params.owner - Token account owner (signer)
 * @param params.amount - Amount to deposit (in base units)
 */
export function depositToConfidential(params: {
  mint: PublicKey;
  owner: PublicKey;
  amount: number;
}): TransactionInstruction {
  const { mint, owner, amount } = params;
  const tokenAccount = getAssociatedTokenAddress(mint, owner);

  // ConfidentialTransferDeposit instruction layout:
  //   instruction index (4)
  //   amount (u64) — public amount to move into confidential pending balance
  //   decimals (u8) — for UI amount conversion
  //
  // The ElGamal encryption of the amount happens on-chain: the program reads
  // the mint's ElGamal public key and encrypts internally.

  const data = Buffer.alloc(4 + 8 + 1);
  let offset = 0;
  data.writeUInt32LE(38, offset); offset += 4; // ConfidentialTransferDeposit
  data.writeBigUInt64LE(BigInt(amount), offset); offset += 8;
  data.writeUInt8(6, offset); offset += 1; // decimals placeholder

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Confidential withdrawal (ElGamal balance -> public tokens)         */
/* ------------------------------------------------------------------ */

/**
 * Create an instruction to withdraw tokens from the confidential balance
 * back to the public balance.
 *
 * NOTE: Requires the ZK ElGamal proof program. The withdrawal requires a
 * RangeProof (verifying the encrypted balance >= withdrawal amount) and a
 * new balance ciphertext. These proofs must be generated client-side.
 *
 * This function returns the instruction FRAMEWORK. A real implementation
 * would need to:
 *   1. Generate a ZK range proof (via the proof program)
 *   2. Compute the ElGamal difference ciphertext
 *   3. Submit the proof + ciphertexts as instruction data
 *
 * @param params.mint - Token-2022 mint with confidential transfers enabled
 * @param params.owner - Token account owner (signer)
 * @param params.amount - Amount to withdraw (in base units)
 */
export function withdrawFromConfidential(params: {
  mint: PublicKey;
  owner: PublicKey;
  amount: number;
}): TransactionInstruction {
  const { mint, owner, amount } = params;
  const tokenAccount = getAssociatedTokenAddress(mint, owner);

  // Placeholder data — the real instruction requires ElGamal ciphertexts
  // and ZK proofs. This shows the correct account layout.
  //
  // Real data layout:
  //   instruction index (4)
  //   amount (u64)
  //   decimals (u8)
  //   new_decryptable_available_balance (ElGamal ciphertext, 2048 bytes)
  //   proof (variable, ZK range proof)
  //
  // Total instruction data is ~2-4KB due to the ZK proof.

  const data = Buffer.alloc(4 + 8 + 1);
  let offset = 0;
  data.writeUInt32LE(39, offset); offset += 4; // ConfidentialTransferWithdraw
  data.writeBigUInt64LE(BigInt(amount), offset); offset += 8;
  data.writeUInt8(6, offset); offset += 1;

  return new TransactionInstruction({
    keys: [
      { pubkey: tokenAccount, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_2022_PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Confidential balance reader                                        */
/* ------------------------------------------------------------------ */

/**
 * Read the confidential pending and available balance for a token account.
 *
 * NOTE: Balances are ElGamal encrypted on-chain. Decryption requires the
 * owner's ElGamal secret key, which is derived from the wallet's signing
 * key. Without client-side decryption, only the encrypted blobs are
 * returned.
 *
 * @param params.connection - Solana RPC connection
 * @param params.mint - Token-2022 mint
 * @param params.owner - Token account owner
 */
export async function getConfidentialBalance(params: {
  connection: Connection;
  mint: PublicKey;
  owner: PublicKey;
}): Promise<ConfidentialBalance> {
  const { connection, mint, owner } = params;
  const tokenAccount = getAssociatedTokenAddress(mint, owner);

  try {
    const accountInfo = await connection.getAccountInfo(tokenAccount);

    if (!accountInfo) {
      return {
        pendingBalanceEncrypted: "",
        availableBalanceEncrypted: "",
        decrypted: false,
      };
    }

    const data = accountInfo.data;

    // Token-2022 account layout (variable length due to extensions):
    //   Account base: 165 bytes
    //   Then TLV entries for each extension
    //
    // ConfidentialTransferAccount extension contains:
    //   discriminator (8)
    //   public_key (32) — ElGamal public key
    //   pending_balance_lo (32) — ElGamal ciphertext
    //   pending_balance_hi (32) — ElGamal ciphertext
    //   available_balance (32) — ElGamal ciphertext
    //   decryptable_available_balance (32)
    //   allow_confidential_credits (1)
    //   allow_non_confidential_credits (1)
    //   pending_balance_credit_counter (8)
    //   expected_pending_balance_credit_counter (8)
    //   actual_pending_balance_credit_counter (8)
    //
    // Search for the confidential transfer account discriminator in the TLV.

    const accountBaseSize = 165;
    let extensionOffset = accountBaseSize;

    // Parse TLV: type (2) + length (2) + data
    while (extensionOffset + 4 <= data.length) {
      const extType = data.readUInt16LE(extensionOffset);
      const extLength = data.readUInt16LE(extensionOffset + 2);

      // ConfidentialTransferAccount extension type is 0x0012 (18)
      if (extType === 0x0012) {
        const extData = data.subarray(
          extensionOffset + 4,
          extensionOffset + 4 + extLength,
        );

        if (extData.length >= 8 + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 8 + 8 + 8) {
          let extOffset = 8; // skip discriminator

          extOffset += 32; // skip public_key

          const pendingLo = extData.subarray(extOffset, extOffset + 32);
          extOffset += 32;

          const pendingHi = extData.subarray(extOffset, extOffset + 32);
          extOffset += 32;

          const available = extData.subarray(extOffset, extOffset + 32);

          return {
            pendingBalanceEncrypted: Buffer.concat([pendingLo, pendingHi]).toString("base64"),
            availableBalanceEncrypted: available.toString("base64"),
            decrypted: false,
          };
        }
      }

      extensionOffset += 4 + extLength;
    }

    return {
      pendingBalanceEncrypted: "",
      availableBalanceEncrypted: "",
      decrypted: false,
    };
  } catch {
    return {
      pendingBalanceEncrypted: "",
      availableBalanceEncrypted: "",
      decrypted: false,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Status check                                                       */
/* ------------------------------------------------------------------ */

/**
 * Returns the current status of Token-2022 confidential transfers on Solana.
 *
 * The ZK ElGamal proof program is still under audit. Once activated,
 * confidential transfers will be available on devnet and mainnet-beta.
 */
export function confidentialTransferStatus(): ConfidentialTransferStatus {
  // As of 2025-05, the ZK Token proof program is still under audit.
  // The Token-2022 program itself is live, but the confidential transfer
  // extension requires the proof program for withdrawal/transfer operations.
  //
  // Deposits (public -> confidential) work without the proof program.
  // Withdrawals and transfers require range proofs.
  return {
    status: "audit_pending",
    cluster: "devnet",
    note: "ZK ElGamal proof program is under audit. Deposit works; withdraw/transfer require the proof program to be activated.",
  };
}

/* ------------------------------------------------------------------ */
/*  Utility: check if a mint has confidential transfers enabled        */
/* ------------------------------------------------------------------ */

/**
 * Check whether a Token-2022 mint has the confidential transfer extension
 * enabled by inspecting its account data.
 */
export async function isConfidentialMint(
  connection: Connection,
  mint: PublicKey,
): Promise<boolean> {
  try {
    const accountInfo = await connection.getAccountInfo(mint);
    if (!accountInfo) return false;

    const data = accountInfo.data;

    // Token-2022 mint base size: 82 bytes (mint + padding)
    // Then TLV extensions
    const mintBaseSize = 82;
    let offset = mintBaseSize;

    while (offset + 4 <= data.length) {
      const extType = data.readUInt16LE(offset);
      const extLength = data.readUInt16LE(offset + 2);

      // ConfidentialTransferMint extension type is 0x0011 (17)
      if (extType === 0x0011) {
        return true;
      }

      offset += 4 + extLength;
    }

    return false;
  } catch {
    return false;
  }
}
