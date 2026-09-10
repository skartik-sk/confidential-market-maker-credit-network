"use client";

/**
 * Note Vault — the owner's private view of their confidential credit notes.
 *
 * Notes (valueUsd + blinding) live ONLY in this browser's localStorage
 * (see lib/persistence). This page lets the owner:
 *   - see summary stats (real private exposure vs the on-chain guess);
 *   - keep every value hidden behind "••••" until individually revealed;
 *   - verify each reveal against the note's SHA-256 commitment;
 *   - release listed notes back to "drawn";
 *   - export / import the whole set as a password-encrypted backup
 *     (scrypt + AES-256-GCM, see lib/note-backup).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { getNotes, saveNotes } from "@/lib/persistence";
import type { StoredNote } from "@/lib/persistence";
import { verifyNote } from "@/lib/note-vault";
import { exportEncryptedBackup, importEncryptedBackup } from "@/lib/note-backup";
import { toast } from "@/lib/toast";

const WalletButton = dynamic(
  () => import("@/components/WalletButton").then(m => m.WalletButton),
  { ssr: false }
);

/* ------------------------------------------------------------------ */
/*  Constants + helpers                                                */
/* ------------------------------------------------------------------ */

/** The denomination an on-chain observer would assume for every note. */
const PUBLIC_DENOMINATION_USD = 1000;
const MIN_PASSWORD_LEN = 8;

type VaultFilter = "all" | "drawn" | "listed" | "repaid";

const FILTERS: { key: VaultFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "drawn", label: "Drawn" },
  { key: "listed", label: "Listed" },
  { key: "repaid", label: "Repaid" },
];

const STATUS_CHIP: Record<StoredNote["status"], string> = {
  drawn: "bg-green-soft text-green",
  listed: "bg-amber-soft text-amber",
  repaid: "bg-bg text-muted border border-line",
  defaulted: "bg-red-soft text-red",
};

const WARNING_TEXT =
  "⚠ Notes live ONLY in this browser's storage. Without an encrypted backup, clearing browser data destroys them.";

function fmtUsd(v: number): string {
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 10)}…${id.slice(-4)}`;
}

function shortHex(hex: string): string {
  return hex.length <= 14 ? hex : `${hex.slice(0, 8)}…${hex.slice(-4)}`;
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export default function VaultPage() {
  const wallet = useWallet();
  const publicKey = wallet.publicKey;
  const walletKey = publicKey ? publicKey.toBase58() : null;
  const connected = wallet.connected && !!publicKey;

  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [filter, setFilter] = useState<VaultFilter>("all");
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Backup form state
  const [exportPassword, setExportPassword] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-read notes from storage whenever the connected wallet changes —
  // including the transition from disconnected (null) to connected.
  // React-approved state adjustment during render (no effect needed).
  if (loadedKey !== walletKey) {
    setLoadedKey(walletKey);
    setNotes(walletKey ? getNotes(walletKey) : []);
    setRevealed(new Set<string>());
  }

  /** Re-read the connected wallet's notes from local storage. */
  const loadNotes = useCallback((announce: boolean) => {
    if (!walletKey) return;
    const stored = getNotes(walletKey);
    setNotes(stored);
    setRevealed(new Set<string>());
    if (announce) {
      toast(`Vault refreshed — ${stored.length} note${stored.length === 1 ? "" : "s"} on file`, "info");
    }
  }, [walletKey]);

  /* Summary stats -------------------------------------------------- */

  const activeNotes = useMemo(
    () => notes.filter(n => n.status === "drawn" || n.status === "listed"),
    [notes]
  );
  const privateExposureUsd = useMemo(
    () => activeNotes.reduce((s, n) => s + n.valueUsd, 0),
    [activeNotes]
  );
  const publicEstimateUsd = activeNotes.length * PUBLIC_DENOMINATION_USD;
  const privacyGapUsd = privateExposureUsd - publicEstimateUsd;
  const gapTone = privacyGapUsd > 0 ? "text-green" : privacyGapUsd < 0 ? "text-red" : "text-ink";

  const counts = useMemo(() => ({
    all: notes.length,
    drawn: notes.filter(n => n.status === "drawn").length,
    listed: notes.filter(n => n.status === "listed").length,
    repaid: notes.filter(n => n.status === "repaid").length,
  }), [notes]);

  const visibleNotes = useMemo(
    () => (filter === "all" ? notes : notes.filter(n => n.status === filter)),
    [notes, filter]
  );

  /* Actions --------------------------------------------------------- */

  const toggleReveal = useCallback((id: string) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const releaseFromListing = useCallback((id: string) => {
    if (!walletKey) return;
    const updated = notes.map(n => (n.id === id ? { ...n, status: "drawn" as const } : n));
    setNotes(updated);
    saveNotes(walletKey, updated);
    toast("Note released from listing — status back to drawn", "success");
  }, [notes, walletKey]);

  const handleExport = useCallback(async () => {
    if (!walletKey) return;
    if (exportPassword.length < MIN_PASSWORD_LEN) {
      toast(`Password must be at least ${MIN_PASSWORD_LEN} characters`, "error");
      return;
    }
    setExporting(true);
    try {
      const envelope = await exportEncryptedBackup(notes, exportPassword);
      const blob = new Blob([envelope], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mute-notes-backup-${backupDateStamp()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportPassword("");
      toast(`Encrypted backup downloaded — ${notes.length} note${notes.length === 1 ? "" : "s"}`, "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Export failed", "error");
    } finally {
      setExporting(false);
    }
  }, [exportPassword, notes, walletKey]);

  const handleImport = useCallback(async () => {
    if (!walletKey) return;
    if (!importFile) {
      toast("Choose a backup file first", "error");
      return;
    }
    if (importPassword.length < MIN_PASSWORD_LEN) {
      toast(`Password must be at least ${MIN_PASSWORD_LEN} characters`, "error");
      return;
    }
    setImporting(true);
    try {
      const text = await importFile.text();
      const imported = await importEncryptedBackup(text, importPassword);
      // Merge by note id: imported entries update existing notes in place,
      // the rest are added. The full merged set is persisted in one write.
      const byId = new Map(notes.map(n => [n.id, n]));
      for (const n of imported) byId.set(n.id, n);
      const merged = [...byId.values()];
      saveNotes(walletKey, merged);
      setNotes(merged);
      setImportPassword("");
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      toast(
        imported.length === 0
          ? "Backup decrypted but contained no valid notes"
          : `Imported ${imported.length} note${imported.length === 1 ? "" : "s"} from backup`,
        imported.length === 0 ? "info" : "success",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Import failed", "error");
    } finally {
      setImporting(false);
    }
  }, [importFile, importPassword, notes, walletKey]);

  /* Render ---------------------------------------------------------- */

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <header className="border-b border-line bg-paper/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-[1840px] mx-auto px-3 sm:px-7 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-6 min-w-0">
            <Link href="/" className="text-lg font-bold tracking-tight shrink-0">Mute</Link>
            <nav className="flex gap-0.5 sm:gap-1">
              <Link href="/" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors whitespace-nowrap">Dashboard</Link>
              <Link href="/trade" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors whitespace-nowrap">Trade</Link>
              <Link href="/exchange" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors whitespace-nowrap">Exchange</Link>
              <span className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-semibold text-red bg-red-soft rounded whitespace-nowrap">Vault</span>
            </nav>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <span suppressHydrationWarning><WalletButton /></span>
          </div>
        </div>
      </header>

      {!connected ? (
        <main className="max-w-md mx-auto px-5 mt-28 pb-16 text-center">
          <h1 className="text-3xl font-bold mb-3">Note Vault</h1>
          <p className="text-muted mb-8">Connect your wallet to view your vault.</p>
          <div className="flex justify-center"><WalletButton /></div>
          <div className="mt-10 rounded-lg border border-red/30 bg-red-soft px-4 py-3 text-left">
            <p className="text-xs text-red leading-relaxed font-medium">{WARNING_TEXT}</p>
          </div>
        </main>
      ) : (
        <main className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6">
          {/* Title + refresh */}
          <div className="flex items-end justify-between flex-wrap gap-3 mb-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight">Note Vault</h1>
              <p className="text-[11px] mono text-muted mt-0.5">
                {walletKey ? `${walletKey.slice(0, 6)}…${walletKey.slice(-4)}` : ""} · values + blindings stored client-side only
              </p>
            </div>
            <button onClick={() => loadNotes(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-line bg-paper hover:border-red/30 transition-colors">
              Refresh
            </button>
          </div>

          {/* Loud warning */}
          <div className="mb-4 rounded-lg border border-red/30 bg-red-soft px-4 py-3">
            <p className="text-xs text-red leading-relaxed font-medium">{WARNING_TEXT}</p>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <div className="card p-4">
              <p className="text-[10px] mono text-muted uppercase">Total Notes</p>
              <p className="text-xl font-bold mt-1">{notes.length}</p>
              <p className="text-[10px] mono text-muted mt-0.5">{counts.drawn} drawn · {counts.listed} listed · {counts.repaid} repaid</p>
            </div>
            <div className="card p-4">
              <p className="text-[10px] mono text-muted uppercase">Private Exposure</p>
              <p className="text-xl font-bold mt-1">{fmtUsd(privateExposureUsd)}</p>
              <p className="text-[10px] mono text-muted mt-0.5">sum of drawn + listed values</p>
            </div>
            <div className="card p-4">
              <p className="text-[10px] mono text-muted uppercase">Public Estimate</p>
              <p className="text-xl font-bold mt-1">{fmtUsd(publicEstimateUsd)}</p>
              <p className="text-[10px] mono text-muted mt-0.5">{activeNotes.length} × $1,000 on-chain guess</p>
            </div>
            <div className="card p-4">
              <p className="text-[10px] mono text-muted uppercase">Privacy Gap</p>
              <p className={`text-xl font-bold mt-1 ${gapTone}`}>
                {privacyGapUsd >= 0 ? "+" : "-"}{fmtUsd(Math.abs(privacyGapUsd))}
              </p>
              <p className="text-[10px] mono text-muted mt-0.5">hidden from on-chain observers</p>
            </div>
          </div>

          {/* Notes table */}
          <section className="card overflow-hidden mb-4">
            <div className="px-4 py-2.5 border-b border-line flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs font-bold">Notes</span>
              <div className="flex gap-1 overflow-x-auto">
                {FILTERS.map(f => (
                  <button key={f.key} onClick={() => setFilter(f.key)}
                    className={`shrink-0 px-2.5 py-1 text-[10px] mono rounded-md transition-colors ${filter === f.key ? "bg-ink text-paper" : "text-muted hover:text-ink bg-bg border border-line"}`}>
                    {f.label} ({counts[f.key]})
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs mono min-w-[820px]">
                <thead>
                  <tr className="border-b border-line text-muted text-[10px] uppercase">
                    <th className="px-4 py-2 text-left font-medium">Note ID</th>
                    <th className="px-4 py-2 text-left font-medium">Market</th>
                    <th className="px-4 py-2 text-left font-medium">Status</th>
                    <th className="px-4 py-2 text-left font-medium">Value</th>
                    <th className="px-4 py-2 text-left font-medium">Commitment</th>
                    <th className="px-4 py-2 text-right font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleNotes.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-12 text-center text-muted">
                        <p className="text-sm mb-1">No notes {filter === "all" ? "in your vault yet" : `with status "${filter}"`}</p>
                        <p className="text-[11px]">Draw credit on the Trade page or import an encrypted backup below.</p>
                      </td>
                    </tr>
                  ) : visibleNotes.map(n => {
                    const isRevealed = revealed.has(n.id);
                    const verified = isRevealed && verifyNote({
                      id: n.id, valueUsd: n.valueUsd, blinding: n.blinding, commitment: n.commitment,
                    });
                    return (
                      <tr key={n.id} className="border-b border-line/50 hover:bg-paper transition-colors">
                        <td className="px-4 py-2.5 text-muted whitespace-nowrap" title={n.id}>{shortId(n.id)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap">{n.market}</td>
                        <td className="px-4 py-2.5">
                          <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${STATUS_CHIP[n.status]}`}>{n.status}</span>
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {isRevealed ? (
                            <div>
                              <div className="font-semibold">{fmtUsd(n.valueUsd)}</div>
                              <div className="text-[10px] text-muted">blinding {shortHex(n.blinding)}</div>
                              <div className={`text-[10px] ${verified ? "text-green" : "text-red"}`}>
                                {verified ? "commitment verified ✓" : "commitment mismatch"}
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-muted">••••</span>
                              <button onClick={() => toggleReveal(n.id)}
                                className="text-[10px] px-2 py-0.5 rounded border border-line text-muted hover:text-ink hover:border-red/30 transition-colors">
                                Reveal
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-[10px] text-muted whitespace-nowrap" title={n.commitment}>{shortHex(n.commitment)}</td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          {isRevealed && (
                            <button onClick={() => toggleReveal(n.id)} className="text-[10px] text-muted hover:text-ink mr-2">Hide</button>
                          )}
                          {n.status === "listed" && (
                            <button onClick={() => releaseFromListing(n.id)}
                              className="text-[10px] px-2 py-1 rounded bg-red text-paper hover:opacity-90 transition-opacity">
                              Release from listing
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* Encrypted backup */}
          <section className="card p-4 sm:p-5">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <h2 className="text-sm font-bold">Encrypted Backup</h2>
              <span className="text-[10px] mono text-muted">scrypt + AES-256-GCM · password never leaves this device</span>
            </div>
            <p className="text-[11px] text-muted mb-4 leading-relaxed">
              Your notes&apos; private values and blindings exist only in this browser. Export an encrypted file to
              survive cleared browser data; import it here to restore or merge notes on any device.
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Export */}
              <div className="rounded-lg border border-line p-4">
                <p className="text-[10px] mono text-muted uppercase mb-2">Export</p>
                <label htmlFor="vault-export-password" className="text-[10px] mono text-muted uppercase block mb-1">
                  Backup password (min {MIN_PASSWORD_LEN} chars)
                </label>
                <input id="vault-export-password" type="password" value={exportPassword}
                  onChange={e => setExportPassword(e.target.value)} placeholder="••••••••" autoComplete="new-password"
                  className="w-full bg-bg border border-line rounded-lg px-3 py-2 text-sm mono focus:outline-none focus:border-red/40 mb-3" />
                <button onClick={handleExport} disabled={exporting}
                  className="w-full py-2.5 rounded-lg bg-red text-paper text-sm font-bold disabled:opacity-30 hover:opacity-90 transition-opacity">
                  {exporting ? "Encrypting…" : "Export encrypted backup"}
                </button>
                <p className="text-[10px] mono text-muted mt-2">{"Downloads mute-notes-backup-<yyyy-mm-dd>.json"}</p>
              </div>
              {/* Import */}
              <div className="rounded-lg border border-line p-4">
                <p className="text-[10px] mono text-muted uppercase mb-2">Import</p>
                <input ref={fileInputRef} type="file" accept=".json,application/json"
                  onChange={e => setImportFile(e.target.files?.[0] ?? null)}
                  className="w-full text-xs mono text-muted bg-bg border border-line rounded-lg px-3 py-2 file:mr-3 file:px-2.5 file:py-1 file:rounded-md file:border-0 file:bg-ink file:text-paper file:text-xs cursor-pointer mb-3" />
                <label htmlFor="vault-import-password" className="text-[10px] mono text-muted uppercase block mb-1">
                  Backup password
                </label>
                <input id="vault-import-password" type="password" value={importPassword}
                  onChange={e => setImportPassword(e.target.value)} placeholder="••••••••" autoComplete="off"
                  className="w-full bg-bg border border-line rounded-lg px-3 py-2 text-sm mono focus:outline-none focus:border-red/40 mb-3" />
                <button onClick={handleImport} disabled={importing}
                  className="w-full py-2.5 rounded-lg bg-ink text-paper text-sm font-bold disabled:opacity-30 hover:opacity-90 transition-opacity">
                  {importing ? "Decrypting…" : "Import backup"}
                </button>
                <p className="text-[10px] mono text-muted mt-2">
                  {importFile ? `Selected: ${importFile.name}` : "Merges by note id — existing notes updated, new notes added"}
                </p>
              </div>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Local-date stamp for the backup filename: yyyy-mm-dd. */
function backupDateStamp(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
