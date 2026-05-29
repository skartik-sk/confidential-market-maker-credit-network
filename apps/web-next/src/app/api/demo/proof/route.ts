import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    cluster: "surfpool",
    programId: "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5",
    coreScope: "Pinocchio credit-vault, fixed-note tranches, receipt hashes, Surfpool localnet proof",
  });
}
