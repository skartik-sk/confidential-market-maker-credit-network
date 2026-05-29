import { NextResponse } from "next/server";
import { getProtocolManifest } from "@/lib/demo-data";

export async function GET() {
  return NextResponse.json(getProtocolManifest());
}
