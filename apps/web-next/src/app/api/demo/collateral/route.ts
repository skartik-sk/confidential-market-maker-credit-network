import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    asset: "USDC",
    deposited: 100_000,
    required: 52_380,
    healthRatio: 1.91,
    status: "healthy",
    rules: {
      minCollateralRatio: 1.5,
      liquidationThreshold: 1.2,
      liquidationBonus: 5,
    },
    breakdown: {
      usdc: 75_000,
      sol: 25_000,
      total: 100_000,
    },
  });
}
