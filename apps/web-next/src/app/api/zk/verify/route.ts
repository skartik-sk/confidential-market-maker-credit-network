import { NextRequest, NextResponse } from "next/server";
import { verifyRangeProof, type NoteZkAttestation } from "@/lib/zk-proof";
import { recordVerification, getVerificationStats, getVerifications } from "@/lib/verify-feed";

/** POST /api/zk/verify — server-side ZK range-proof verification.
 *
 * The client proves (in zero knowledge) that a confidential note's value is a
 * legitimate integer in [0, 2^16) WITHOUT revealing it. This endpoint is the
 * platform/auditor role: it verifies the cryptographic proof and learns
 * NOTHING about the value beyond its range. */

/* ------------------------------------------------------------------ */
/*  Rate limiting (in-module, per client IP)                           */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_PER_MIN = 60;
const RATE_WINDOW_MS = 60_000;
/** Cap on tracked IPs so the Map can't grow unboundedly under abuse. */
const RATE_MAP_CAP = 10_000;

const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Sliding one-minute window per x-forwarded-for. Returns false when over budget. */
function allowRequest(ip: string): boolean {
  const now = Date.now();
  // Prune expired buckets so the Map stays small.
  if (rateBuckets.size > 128) {
    for (const [key, bucket] of rateBuckets) {
      if (now - bucket.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(key);
    }
  }
  if (rateBuckets.size >= RATE_MAP_CAP && !rateBuckets.has(ip)) {
    return false; // untrackable load — refuse rather than grow forever
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_PER_MIN) return false;
  bucket.count += 1;
  return true;
}

/* ------------------------------------------------------------------ */
/*  POST — verify proofs                                               */
/* ------------------------------------------------------------------ */

export async function POST(request: NextRequest) {
  if (!allowRequest(clientIp(request))) {
    return NextResponse.json(
      { error: "rate limit exceeded (60 requests/minute)" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
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

    const at = Date.now();
    const results = attestations.map((a) => ({
      noteId: typeof a?.noteId === "string" ? a.noteId : "",
      valid: Boolean(
        a?.proof &&
          typeof a.noteId === "string" &&
          verifyRangeProof(a.proof) &&
          a.proof.context === `mute-note:${a.noteId}`,
      ),
    }));

    // Feed the auditor view: which note, valid or not, when — and nothing
    // about the values (note ids are truncated to what's needed for display).
    for (const r of results) {
      recordVerification({ noteId: r.noteId.slice(0, 12), valid: r.valid, at });
    }

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

/* ------------------------------------------------------------------ */
/*  GET — aggregate stats for the auditor view                         */
/* ------------------------------------------------------------------ */

/** GET /api/zk/verify — verification feed stats (validity counts only).
 *  Also returns the recent per-note events (truncated ids, no values) so the
 *  auditor page can render its live table. In-memory: resets on cold starts. */
export async function GET(request: NextRequest) {
  if (!allowRequest(clientIp(request))) {
    return NextResponse.json(
      { error: "rate limit exceeded (60 requests/minute)" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const recent = getVerifications();
  return NextResponse.json(
    {
      stats: getVerificationStats(),
      recent: recent.slice(-50).reverse(),
    },
    { status: 200 },
  );
}
