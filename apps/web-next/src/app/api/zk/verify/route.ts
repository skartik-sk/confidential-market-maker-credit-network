import { NextRequest, NextResponse } from "next/server";
import { verifyRangeProof, type NoteZkAttestation } from "@/lib/zk-proof";

/** POST /api/zk/verify — server-side ZK range-proof verification.
 *
 * The client proves (in zero knowledge) that a confidential note's value is a
 * legitimate integer in [0, 2^16) WITHOUT revealing it. This endpoint is the
 * platform/auditor role: it verifies the cryptographic proof and learns
 * NOTHING about the value beyond its range. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const attestations: NoteZkAttestation[] = Array.isArray(body?.attestations)
      ? body.attestations
      : [];
    if (attestations.length === 0) {
      return NextResponse.json({ error: "attestations required" }, { status: 400 });
    }
    if (attestations.length > 100) {
      return NextResponse.json({ error: "too many attestations (max 100)" }, { status: 400 });
    }

    const results = attestations.map((a) => ({
      noteId: typeof a?.noteId === "string" ? a.noteId : "",
      valid: Boolean(
        a?.proof &&
          typeof a.noteId === "string" &&
          verifyRangeProof(a.proof) &&
          a.proof.context === `mute-note:${a.noteId}`,
      ),
    }));
    return NextResponse.json(
      {
        allValid: results.every((r) => r.valid),
        verified: results.filter((r) => r.valid).length,
        total: results.length,
        results,
      },
      { status: 200 },
    );
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
}
