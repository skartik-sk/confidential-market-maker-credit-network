import { NextResponse } from "next/server";
import { getDemoRiskCompute } from "@/lib/demo-data";

export async function GET() {
  return NextResponse.json(getDemoRiskCompute());
}
