import { NextResponse } from "next/server";
import { getDemoSettlement } from "@/lib/demo-data";

export async function GET() {
  return NextResponse.json(getDemoSettlement());
}
