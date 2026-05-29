import { NextResponse } from "next/server";

const DEVNET_PROGRAM_ID = "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5";

export async function GET() {
  return NextResponse.json({
    ok: true,
    cluster: "devnet",
    programId: DEVNET_PROGRAM_ID,
    deploySignature: "4CyLZX5vvzEqjyxvpPPeR768NBcX59aJ15Q2awy3SoRDvdukkUYmit2ajLzxoThhqvkPvccQ8q7XEMGdt5gaRuPA",
    explorerProgram: `https://explorer.solana.com/address/${DEVNET_PROGRAM_ID}?cluster=devnet`,
    pinocchioVersion: "0.11.1",
    deployedAt: "2026-05-29",
    features: ["credit-vault", "magicblock-delegation", "commit", "commit-and-undelegate", "undelegate-callback"],
  });
}
