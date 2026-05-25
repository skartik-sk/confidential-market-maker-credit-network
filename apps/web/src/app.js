const computeLimits = {
  initializePool: 1300,
  approveCreditLine: 1100,
  drawTranche: 950,
  repayTranche: 950,
  postReceipt: 850,
  settleMaturity: 900,
};

let currentStep = 0;
let flowSteps = [];
let runTimer;

async function loadDashboard() {
  const [proof, protocol, creditLine, privacy] = await Promise.all([
    fetchJson("/api/demo/proof"),
    fetchJson("/api/demo/protocol"),
    fetchJson("/api/demo/credit-line"),
    fetchJson("/api/demo/privacy-options"),
  ]);

  const latest = proof.latestSmoke ?? {};
  const computeUnits = latest.computeUnits ?? proof.computeUnits ?? {};
  const finalLine = latest.finalLineSnapshot ?? creditLine;

  setText("proof-state", proof.ok ? "verified" : "offline");
  setText("line-id", creditLine.id);
  setText("program-id", proof.programId ?? protocol.program.name);
  setText("sbf-hash", compactHash(proof.soSha256 ?? "proof unavailable"));
  setText("cluster-name", proof.cluster ?? protocol.localnet.validator);
  setText("deploy-slot", proof.lastDeployedInSlot ? `${proof.lastDeployedInSlot}` : "unavailable");
  setText("binary-size", proof.dataLengthBytes ? `${formatBytes(proof.dataLengthBytes)}` : "unavailable");
  setText("limit-notes", `${creditLine.limitNotes} notes`);
  setText("drawn-notes", `${creditLine.drawnNotes} notes`);
  setText("repaid-notes", `${creditLine.repaidNotes} notes`);
  setText("max-cu", `${maxCompute(computeUnits) || "--"}`);

  flowSteps = buildFlowSteps({ proof, creditLine, finalLine, computeUnits });
  renderFlowSteps();
  setActiveStep(0);
  renderPrivacyOptions(privacy.options ?? []);
  bindControls();
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function buildFlowSteps({ proof, creditLine, finalLine, computeUnits }) {
  const receipt = creditLine.receipts?.[0];
  const draw = creditLine.drawHistory?.[0];
  return [
    {
      label: "request",
      title: "Borrower commits terms",
      summary: "The borrower opens a private deal room and publishes only deterministic commitments.",
      output: {
        borrower: creditLine.borrower,
        auditor: creditLine.auditor,
        terms: creditLine.termsHash,
      },
    },
    {
      label: "approve",
      title: "Underwriter approves a bounded line",
      summary: "The line is capped by fixed notes, allowed markets, receipt cadence, and spend limits.",
      output: {
        limit: `${creditLine.limitNotes} notes`,
        note: `$${creditLine.noteSizeUsd.toLocaleString()} each`,
        markets: creditLine.mandate.allowedMarkets.join(", "),
      },
    },
    {
      label: "draw",
      title: "Market maker draws inventory credit",
      summary: "The draw changes public note counts while strategy details stay behind commitments.",
      output: {
        drawn: `${draw?.notes ?? creditLine.drawnNotes} notes`,
        market: draw?.market ?? "SOL-PERP",
        compute: formatCu(computeUnits.drawTranche, computeLimits.drawTranche),
      },
    },
    {
      label: "receipt",
      title: "Auditor posts a receipt hash",
      summary: "Risk reports become compact receipt hashes that other machines can verify later.",
      output: {
        receipt: receipt?.receiptHash ?? "receipt unavailable",
        signer: receipt?.signer ?? creditLine.auditor,
        compute: formatCu(computeUnits.postReceipt, computeLimits.postReceipt),
      },
    },
    {
      label: "settle",
      title: "Repay or settle maturity",
      summary: "Repayment and maturity settlement close the accounting loop without moving privacy logic into x402.",
      output: {
        repaid: `${creditLine.repaidNotes} notes`,
        final: statusLabel(finalLine.status),
        compute: formatCu(computeUnits.settleMaturity, computeLimits.settleMaturity),
      },
    },
  ];
}

function renderFlowSteps() {
  const list = document.getElementById("flow-steps");
  list.replaceChildren();
  flowSteps.forEach((step, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "flow-step";
    button.dataset.index = `${index}`;
    button.innerHTML = `
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${step.title}</strong>
      <em>${step.label}</em>
    `;
    button.addEventListener("click", () => setActiveStep(index));
    list.append(button);
  });
}

function renderPrivacyOptions(options) {
  const list = document.getElementById("privacy-options");
  list.replaceChildren();
  for (const option of options.filter((item) => item.status !== "native-guarded")) {
    const item = document.createElement("article");
    item.className = "privacy-row";
    item.dataset.status = option.status;

    const status = document.createElement("span");
    status.className = "privacy-status";
    status.textContent = statusLabelForRail(option);

    const title = document.createElement("h3");
    title.textContent = option.label;

    const body = document.createElement("p");
    body.textContent = option.bestFor;

    item.append(status, title, body);
    list.append(item);
  }
}

function bindControls() {
  document.getElementById("run-flow")?.addEventListener("click", runFlow);
  document.getElementById("hero-run")?.addEventListener("click", runFlow);
  document.getElementById("step-next")?.addEventListener("click", () => {
    setActiveStep((currentStep + 1) % flowSteps.length);
  });
}

function runFlow() {
  clearInterval(runTimer);
  setActiveStep(0);
  runTimer = setInterval(() => {
    if (currentStep >= flowSteps.length - 1) {
      clearInterval(runTimer);
      return;
    }
    setActiveStep(currentStep + 1);
  }, 850);
}

function setActiveStep(index) {
  if (!flowSteps.length) return;
  currentStep = index;
  const step = flowSteps[index];
  setText("active-step-index", String(index + 1).padStart(2, "0"));
  setText("active-step-title", step.title);
  setText("active-step-summary", step.summary);

  const output = document.getElementById("active-step-output");
  output.replaceChildren();
  for (const [key, value] of Object.entries(step.output)) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = key;
    detail.textContent = value;
    row.append(term, detail);
    output.append(row);
  }

  document.querySelectorAll(".flow-step").forEach((item) => {
    item.classList.toggle("is-active", Number(item.dataset.index) === index);
    item.classList.toggle("is-complete", Number(item.dataset.index) < index);
  });
}

function statusLabelForRail(option) {
  const labels = {
    "encrypted-deal-room": "private terms",
    "fixed-note-control-plane": "vault accounting",
    "umbra-shielded-settlement": "private settlement",
    "arcium-risk-compute": "encrypted risk",
    "magicblock-private-session": "fast session",
  };
  return labels[option.id] ?? "privacy rail";
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function compactHash(value) {
  if (value.length <= 22) return value;
  return `${value.slice(0, 12)}...${value.slice(-10)}`;
}

function maxCompute(computeUnits) {
  return Math.max(0, ...Object.values(computeUnits).filter(Number.isFinite));
}

function formatCu(consumed, limit) {
  return Number.isFinite(consumed) ? `${consumed}/${limit} CU` : `under ${limit} CU`;
}

function statusLabel(status) {
  const labels = {
    1: "active",
    2: "closed",
    3: "delinquent",
    4: "defaulted",
    5: "paused",
  };
  return labels[status] ?? `${status ?? "unknown"}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "--";
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

loadDashboard().catch((error) => {
  setText("proof-state", "error");
  setText("line-id", error.message);
});
