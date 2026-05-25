import { buildDemoCreditLine } from "../../api/src/server";
import {
  drawTranche,
  postRiskReceipt,
  settleMaturity,
  type CreditLine,
} from "../../../packages/credit-engine/src";

interface WorkerEvent {
  level: "info" | "warn";
  type: string;
  message: string;
  creditLineId: string;
}

export function evaluateCreditLine(line: CreditLine, currentSlot: number): WorkerEvent[] {
  const events: WorkerEvent[] = [];

  if (line.repaymentDueUsd > 0) {
    events.push({
      level: "info",
      type: "open_exposure",
      message: `Line has ${line.exposureUsd} USD outstanding and ${line.repaymentDueUsd} USD due.`,
      creditLineId: line.id,
    });
  }

  const latestReceipt = line.receipts.at(-1);
  if (
    latestReceipt &&
    currentSlot - latestReceipt.periodEndSlot > line.mandate.requiredReceiptIntervalSlots
  ) {
    events.push({
      level: "warn",
      type: "receipt_stale",
      message: "Risk receipt interval breached; underwriter should request a new report hash.",
      creditLineId: line.id,
    });
  }

  const matured = settleMaturity(line, { currentSlot });
  if (matured.status === "delinquent") {
    events.push({
      level: "warn",
      type: "maturity_delinquent",
      message: `Line is past maturity with ${matured.defaultedNotes} defaulted notes.`,
      creditLineId: line.id,
    });
  }

  return events;
}

export function buildWatchedLine(): CreditLine {
  const line = buildDemoCreditLine();
  const drawn = drawTranche(line, {
    notes: 12,
    market: "SOL-PERP",
    asset: "USDC",
    purpose: "backstop_liquidations",
    currentSlot: 20_050,
  });

  return postRiskReceipt(drawn, {
    receiptHash: "receipt_worker_demo_01",
    signer: "AUD-DEMO-01",
    periodStartSlot: 20_050,
    periodEndSlot: 20_100,
    currentSlot: 20_101,
  });
}

function runOnce(): void {
  const line = buildWatchedLine();
  const events = evaluateCreditLine(line, 50_500);
  console.log(JSON.stringify({ service: "confidential-credit-worker", events }, null, 2));
}

if (process.argv.includes("--once")) {
  runOnce();
  process.exit(0);
}

console.log("confidential credit worker started; press Ctrl+C to stop");
setInterval(runOnce, 15_000);
runOnce();
