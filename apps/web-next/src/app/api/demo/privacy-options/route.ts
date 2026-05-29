import { NextResponse } from "next/server";
import { getPrivacyOptions } from "@/lib/demo-data";

export async function GET() {
  return NextResponse.json({
    options: getPrivacyOptions(),
    rule: "The vault remains the accounting truth; privacy rails attach at settlement, risk, and disclosure boundaries.",
  });
}
