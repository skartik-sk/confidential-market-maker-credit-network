"use client";

/**
 * Global toast notifications — tiny event-emitter store + <Toaster/> portal.
 *
 * Usage: `import { toast } from "@/lib/toast"` then `toast("filled ✓", "success")`.
 * Mount <Toaster /> once (it lives in app/layout.tsx).
 */

import { useEffect, useState } from "react";

export type ToastKind = "info" | "success" | "error";
export interface ToastItem { id: number; kind: ToastKind; message: string }

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit(): void {
  for (const l of listeners) l([...items]);
}

function dismiss(id: number): void {
  items = items.filter(t => t.id !== id);
  emit();
}

export function toast(message: string, kind: ToastKind = "info"): void {
  const item: ToastItem = { id: nextId++, kind, message };
  items = [item, ...items].slice(0, 4);
  emit();
  setTimeout(() => dismiss(item.id), 4500);
}

const KIND_STYLES: Record<ToastKind, string> = {
  info: "border-line bg-paper text-ink",
  success: "border-green/30 bg-green-soft text-green",
  error: "border-red/30 bg-red-soft text-red",
};

const KIND_DOT: Record<ToastKind, string> = {
  info: "bg-muted",
  success: "bg-green",
  error: "bg-red",
};

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>([]);
  useEffect(() => {
    listeners.add(setList);
    return () => { listeners.delete(setList); };
  }, []);
  if (list.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] w-[min(92vw,380px)] space-y-2">
      {list.map(t => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`w-full text-left px-4 py-3 rounded-lg border shadow-lg flex items-start gap-2.5 text-xs transition-opacity hover:opacity-80 ${KIND_STYLES[t.kind]}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${KIND_DOT[t.kind]}`} />
          <span className="mono leading-snug break-words">{t.message}</span>
        </button>
      ))}
    </div>
  );
}
