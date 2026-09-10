/**
 * In-memory verification feed for the ZK range-proof verifier.
 *
 * Every POST /api/zk/verify records what the platform (auditor role) learned:
 * WHICH note was proven, WHETHER the proof was valid, and WHEN — and nothing
 * else. Note values never enter this feed (the whole point of the ZK proof is
 * that the verifier cannot see them).
 *
 * The buffer is a bounded FIFO ring (oldest entries drop off at 200). State is
 * module-scoped on purpose: it survives across requests within one server
 * instance but resets on serverless cold starts — the auditor UI says so
 * honestly rather than pretending this is durable history.
 */

/** One recorded proof verification (no values — only validity). */
export interface VerificationEvent {
  /** Note identifier, truncated by the caller for display safety. */
  noteId: string;
  /** Whether the ZK range proof verified. */
  valid: boolean;
  /** Wall-clock time of the verification (Date.now() ms). */
  at: number;
}

export interface VerificationStats {
  /** Verifications currently held in the buffer. */
  total: number;
  valid: number;
  invalid: number;
}

/** Ring buffer capacity. */
export const MAX_VERIFICATIONS = 200;

const events: VerificationEvent[] = [];

/**
 * Record one verification result. Oldest entries are evicted once the buffer
 * exceeds MAX_VERIFICATIONS.
 */
export function recordVerification(event: VerificationEvent): void {
  events.push({
    noteId: String(event?.noteId ?? ""),
    valid: Boolean(event?.valid),
    at: Number(event?.at) || Date.now(),
  });
  if (events.length > MAX_VERIFICATIONS) {
    events.splice(0, events.length - MAX_VERIFICATIONS);
  }
}

/** Snapshot of the feed, oldest first. */
export function getVerifications(): VerificationEvent[] {
  return [...events];
}

/** Aggregate counts over the current buffer contents. */
export function getVerificationStats(): VerificationStats {
  let valid = 0;
  for (const e of events) if (e.valid) valid += 1;
  return { total: events.length, valid, invalid: events.length - valid };
}
