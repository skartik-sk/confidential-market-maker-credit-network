import { NextResponse } from "next/server";

const PROGRAM_ID = "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5";
const RPC = "https://api.devnet.solana.com";

export async function GET() {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [PROGRAM_ID, { encoding: "base64" }],
      }),
    });
    const data = await res.json();
    const info = data?.result?.value;
    if (!info) {
      return NextResponse.json({ live: false, programId: PROGRAM_ID });
    }
    const binarySize = info.data ? Buffer.from(info.data[0], "base64").length : 0;
    return NextResponse.json({
      live: true,
      executable: info.executable,
      owner: info.owner,
      lamports: info.lamports,
      binarySize,
      slot: data.result?.context?.slot,
      programId: PROGRAM_ID,
      explorer: `https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet`,
      deployTx: "4CyLZX5vvzEqjyxvpPPeR768NBcX59aJ15Q2awy3SoRDvdukkUYmit2ajLzxoThhqvkPvccQ8q7XEMGdt5gaRuPA",
    });
  } catch {
    return NextResponse.json({ live: false, programId: PROGRAM_ID, error: "RPC fetch failed" });
  }
}
