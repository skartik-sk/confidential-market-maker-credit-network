import { NextResponse } from "next/server";

const DEVNET_PROGRAM_ID = "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5";

export async function GET() {
  return NextResponse.json({
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    programId: DEVNET_PROGRAM_ID,
    explorer: `https://explorer.solana.com/address/${DEVNET_PROGRAM_ID}?cluster=devnet`,
    magicblock: {
      erRpc: "https://devnet-as.magicblock.app",
      teeRpc: "https://devnet-tee.magicblock.app",
      delegationProgram: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh",
      validatorAsia: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
      validatorTee: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
    },
  });
}
