import { NextResponse } from "next/server";
import { getDemoCreditLine } from "@/lib/demo-data";

export async function GET() {
  return NextResponse.json(getDemoCreditLine());
}
