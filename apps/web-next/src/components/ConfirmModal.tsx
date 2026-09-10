"use client";

/**
 * Brand-styled confirmation modal for money-moving actions (buy, draw, repay).
 * Requires a checkbox acknowledgement before confirming — cheap friction that
 * prevents fat-finger trades.
 */

import { useEffect, useState } from "react";

export function ConfirmModal({ open, title, lines, confirmLabel, busy, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  /** Key/value lines shown in the body (e.g. { Ask: "$4,850", Discount: "3%" }). */
  lines: Record<string, string>;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [acked, setAcked] = useState(false);
  useEffect(() => { if (open) setAcked(false); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" role="dialog" aria-modal>
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={busy ? undefined : onCancel} />
      <div className="relative bg-paper border border-line rounded-xl w-full max-w-md shadow-2xl">
        <div className="px-5 py-4 border-b border-line">
          <h3 className="font-bold text-sm">{title}</h3>
        </div>
        <div className="p-5 space-y-3">
          <div className="bg-bg rounded-lg p-3 mono text-xs space-y-1.5">
            {Object.entries(lines).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <span className="text-muted uppercase text-[10px] pt-0.5">{k}</span>
                <span className="font-semibold text-right break-all">{v}</span>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-xs text-muted cursor-pointer select-none">
            <input type="checkbox" checked={acked} onChange={e => setAcked(e.target.checked)} className="mt-0.5 accent-[#dc2b28]" />
            <span>I understand — values stay confidential, but this action is final once confirmed on devnet.</span>
          </label>
        </div>
        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy} className="px-4 h-9 rounded-lg border border-line text-xs font-semibold hover:border-ink transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!acked || busy}
            className="px-4 h-9 rounded-lg bg-red text-paper text-xs font-bold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmModal;
