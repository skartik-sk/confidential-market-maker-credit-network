const computeLimits = {
  initializePool: 1300,
  approveCreditLine: 1100,
  drawTranche: 950,
  repayTranche: 950,
  postReceipt: 850,
  settleMaturity: 900,
  delegateCreditLine: 1100,
  commitCreditLine: 600,
};

let currentStep = 0;
let flowSteps = [];
let runTimer;

async function loadDashboard() {
  // Bind controls immediately so buttons always work
  bindControls();

  const [proof, protocol, creditLine, privacy, devnetProof, devnetInfo] = await Promise.all([
    fetchJson("/api/demo/proof").catch(() => ({ ok: false })),
    fetchJson("/api/demo/protocol").catch(() => ({ program: { name: "unknown" } })),
    fetchJson("/api/demo/credit-line").catch(() => null),
    fetchJson("/api/demo/privacy-options").catch(() => ({ options: [] })),
    fetchJson("/api/devnet/proof").catch(() => ({ ok: false })),
    fetchJson("/api/devnet/info").catch(() => null),
  ]);

  // Guard: if credit-line failed, show error and stop
  if (!creditLine) {
    setText("proof-state", "error");
    setText("line-id", "failed to load credit line");
    return;
  }

  const latest = proof.latestSmoke ?? {};
  const computeUnits = latest.computeUnits ?? proof.computeUnits ?? {};
  const finalLine = latest.finalLineSnapshot ?? creditLine;

  // Show devnet status if available
  const isDevnet = devnetProof.ok || devnetInfo;
  const clusterLabel = isDevnet ? "devnet" : (proof.cluster ?? "surfpool");

  setText("proof-state", devnetProof.ok ? "devnet ✅" : (proof.ok ? "verified" : "offline"));
  setText("line-id", creditLine.id);
  setText("program-id", proof.programId ?? protocol?.program?.name ?? "unknown");
  setText("sbf-hash", compactHash(proof.soSha256 ?? "proof unavailable"));
  setText("cluster-name", clusterLabel);
  setText("deploy-slot", proof.lastDeployedInSlot ? `${proof.lastDeployedInSlot}` : "unavailable");
  setText("binary-size", proof.dataLengthBytes ? `${formatBytes(proof.dataLengthBytes)}` : "unavailable");
  setText("limit-notes", `${creditLine.limitNotes} notes`);
  setText("drawn-notes", `${creditLine.drawnNotes} notes`);
  setText("repaid-notes", `${creditLine.repaidNotes} notes`);
  setText("max-cu", `${maxCompute(computeUnits) || "--"}`);

  // Show devnet Explorer link if available
  const explorerEl = document.getElementById("devnet-explorer");
  if (explorerEl && isDevnet) {
    const pid = devnetInfo?.programId ?? proof.programId ?? "";
    const link = document.createElement("a");
    link.href = `https://explorer.solana.com/address/${pid}?cluster=devnet`;
    link.target = "_blank";
    link.rel = "noopener";
    link.className = "secondary-button";
    link.textContent = "View on Solana Explorer";
    explorerEl.replaceChildren(link);
  }

  // Show MagicBlock ER info
  const mbEl = document.getElementById("magicblock-status");
  if (mbEl && devnetInfo?.magicblock) {
    const pill = document.createElement("span");
    pill.className = "state-pill";
    pill.style.background = "#ecfff4";
    pill.textContent = "MagicBlock ER connected";
    mbEl.replaceChildren(pill);
  }

  // Show devnet live banner with transaction links
  const bannerEl = document.getElementById("devnet-banner");
  if (bannerEl && isDevnet && devnetProof.ok) {
    bannerEl.style.display = "";
    setText("devnet-program-id", devnetProof.programId ?? "");

    const txLinks = document.getElementById("devnet-tx-links");
    if (txLinks && devnetProof.signatures) {
      txLinks.replaceChildren();
      const labels = {
        initializePool: "Init Pool",
        approveCreditLine: "Approve Line",
        drawTranche: "Draw",
        repayTranche: "Repay",
        postReceipt: "Receipt",
        settleMaturity: "Settle",
      };
      const explorers = devnetProof.explorerLinks ?? {};
      for (const [key, sig] of Object.entries(devnetProof.signatures)) {
        const href = explorers[key] ?? `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = labels[key] ?? key;
        txLinks.append(a);
      }
    }
  }

  flowSteps = buildFlowSteps({ proof, creditLine, finalLine, computeUnits });
  renderFlowSteps();
  setActiveStep(0);
  renderPrivacyOptions(privacy.options ?? []);
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function buildFlowSteps({ proof, creditLine, finalLine, computeUnits }) {
  const receipt = creditLine.receipts?.[0];
  const draw = creditLine.drawHistory?.[0];
  const programId = proof.programId ?? "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5";
  return [
    {
      label: "request",
      title: "Borrower commits terms",
      summary: "The borrower opens a private deal room and publishes only deterministic commitments. Strategy, venues, and exposure stay encrypted.",
      output: {
        borrower: creditLine.borrower,
        auditor: creditLine.auditor,
        terms: creditLine.termsHash,
      },
    },
    {
      label: "approve",
      title: "Underwriter approves a bounded line",
      summary: "The line is capped by fixed notes, allowed markets, receipt cadence, and spend limits. The underwriter controls pause/reactivation.",
      output: {
        limit: `${creditLine.limitNotes} notes`,
        note: `$${creditLine.noteSizeUsd.toLocaleString()} each`,
        markets: creditLine.mandate.allowedMarkets.join(", "),
      },
    },
    {
      label: "draw",
      title: "Market maker draws inventory credit",
      summary: "The draw changes public note counts while strategy details stay behind commitments. Each note is a fixed $1,000 chunk — exact amounts stay hidden.",
      output: {
        drawn: `${draw?.notes ?? creditLine.drawnNotes} notes`,
        market: draw?.market ?? "SOL-PERP",
        compute: formatCu(computeUnits.drawTranche, computeLimits.drawTranche),
      },
    },
    {
      label: "delegate",
      title: "Delegate to MagicBlock ER",
      summary: "The credit-line account is delegated to MagicBlock's Execution Runtime for sub-millisecond private quoting sessions away from public view.",
      output: {
        program: compactHash(programId),
        validator: "MAS1Dt9...Czk57 (Asia)",
        rpc: "devnet-as.magicblock.app",
        compute: formatCu(computeUnits.delegateCreditLine, computeLimits.delegateCreditLine),
      },
    },
    {
      label: "commit",
      title: "Commit session back to vault",
      summary: "After the private session ends, the finalized state is committed back to the Pinocchio vault on Solana. The ER undelegates and the buffer restores the account.",
      output: {
        action: "commit + undelegate",
        settled_to: "Pinocchio vault",
        compute: formatCu(computeUnits.commitCreditLine, computeLimits.commitCreditLine),
      },
    },
    {
      label: "receipt",
      title: "Auditor posts a receipt hash",
      summary: "Risk reports become compact receipt hashes that other machines can verify later. The auditor never sees raw inventory — only a pass/fail commitment.",
      output: {
        receipt: receipt?.receiptHash ?? "receipt unavailable",
        signer: receipt?.signer ?? creditLine.auditor,
        compute: formatCu(computeUnits.postReceipt, computeLimits.postReceipt),
      },
    },
    {
      label: "settle",
      title: "Repay or settle maturity",
      summary: "The borrower repays notes before maturity. If maturity passes with outstanding notes, they default. The vault closes the accounting loop cleanly.",
      output: {
        repaid: `${creditLine.repaidNotes} notes`,
        outstanding: `${creditLine.drawnNotes - creditLine.repaidNotes - creditLine.defaultedNotes} notes`,
        status: statusLabel(finalLine.status),
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

    const num = document.createElement("span");
    num.textContent = String(index + 1).padStart(2, "0");

    const title = document.createElement("strong");
    title.textContent = step.title;

    const label = document.createElement("em");
    label.textContent = step.label;

    button.append(num, title, label);
    button.addEventListener("click", () => setActiveStep(index));
    list.append(button);
  });
}

function renderPrivacyOptions(options) {
  const list = document.getElementById("privacy-options");
  list.replaceChildren();
  for (const option of options) {
    const item = document.createElement("article");
    item.className = "privacy-row";
    item.dataset.status = option.status;

    const status = document.createElement("span");
    status.className = "privacy-status";
    status.textContent = statusLabelForRail(option);

    const title = document.createElement("h3");
    title.textContent = option.label;

    const body = document.createElement("p");
    if (option.status === "native-guarded") {
      body.textContent = option.bestFor + " — this extension requires Solana's ZK ElGamal proof program, which is currently under security audit and not yet deployed to devnet.";
    } else {
      body.textContent = option.bestFor;
    }

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
