"use client";

/**
 * Brand-styled wallet button — replaces the default wallet-adapter button
 * (and its clashing purple styling) with the Mute look: black action button,
 * red hover, mono address pill, and a dropdown picker for installed wallets.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";

function truncate(pk: string): string {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export function WalletButton() {
  const {
    wallets,
    select,
    connect,
    connecting,
    connected,
    publicKey,
    disconnect,
    wallet: selectedWallet,
  } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on outside clicks.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the picker when the wallet connects
    if (connected) setOpen(false);
  }, [connected]);

  const pickWallet = useCallback(
    async (name: string) => {
      select(name as WalletName);
      // connect() must run after the select state lands — next tick suffices.
      await new Promise((r) => setTimeout(r, 0));
      try {
        await connect();
      } catch {
        /* user rejected or wallet missing — keep the picker open */
        return;
      }
      setOpen(false);
    },
    [select, connect],
  );

  const copyAddress = useCallback(async () => {
    if (!publicKey) return;
    try {
      await navigator.clipboard.writeText(publicKey.toBase58());
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }, [publicKey]);

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed);
  const listable = installed.length > 0 ? installed : wallets.slice(0, 4);

  return (
    <div ref={rootRef} className="relative">
      {!connected ? (
        <button
          onClick={() => setOpen(o => !o)}
          disabled={connecting}
          className="h-10 px-5 rounded-lg bg-ink text-paper text-sm font-bold hover:bg-red transition-colors disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect Wallet"}
        </button>
      ) : (
        <button
          onClick={() => setOpen(o => !o)}
          className="h-10 px-4 rounded-lg border border-line bg-paper text-sm font-semibold hover:border-red/40 transition-colors flex items-center gap-2"
        >
          {selectedWallet?.adapter.icon && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selectedWallet.adapter.icon} alt="" className="w-4 h-4" />
          )}
          <span className="mono text-xs">{publicKey ? truncate(publicKey.toBase58()) : "…"}</span>
          <span className="w-1.5 h-1.5 rounded-full bg-green inline-block" />
        </button>
      )}

      {open && (
        <div className="absolute right-0 mt-2 w-60 bg-paper border border-line rounded-lg shadow-lg overflow-hidden z-50">
          {!connected ? (
            <>
              <p className="px-4 pt-3 pb-1 text-[10px] mono uppercase text-muted">Select a wallet</p>
              {listable.map(w => (
                <button
                  key={w.adapter.name}
                  onClick={() => pickWallet(w.adapter.name)}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-sm hover:bg-red-soft transition-colors text-left"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {w.adapter.icon && <img src={w.adapter.icon} alt="" className="w-5 h-5" />}
                  <span className="font-medium">{w.adapter.name}</span>
                  {w.readyState !== WalletReadyState.Installed && <span className="ml-auto text-[10px] mono text-muted">load</span>}
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-line">
                <p className="mono text-xs">{publicKey?.toBase58()}</p>
              </div>
              <button
                onClick={copyAddress}
                className="w-full px-4 py-2.5 text-sm text-left hover:bg-red-soft transition-colors"
              >
                {copied ? "✓ Copied" : "Copy address"}
              </button>
              <button
                onClick={() => { disconnect(); setOpen(false); }}
                className="w-full px-4 py-2.5 text-sm text-left text-red hover:bg-red-soft transition-colors"
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default WalletButton;
