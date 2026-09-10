"use client";

/**
 * SVG market-depth chart for the exchange order book.
 *
 * Asks (red) form a step-area on the RIGHT of the mid, bids (green) a
 * step-area on the LEFT. x = price as % of par (priceBps / 100),
 * y = cumulative notes. Pure render — no state, no network.
 */

const RED = "#dc2b28";
const GREEN = "#1fad60";
const GRID = "#ece8e3";
const MUTED = "#9a928a";
const INK = "#151514";

export interface DepthLevel {
  priceBps: number;
  notes: number;
}

interface DepthPoint {
  /** Price as % of par. */
  x: number;
  /** Cumulative notes at this price. */
  cum: number;
}

export function DepthChart({ asks, bids }: { asks: DepthLevel[]; bids: DepthLevel[] }) {
  const W = 268, H = 132;
  const PAD_L = 34, PAD_R = 8, PAD_T = 14, PAD_B = 20;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const baseY = PAD_T + innerH;

  // Best ask = lowest price → sort ascending. Best bid = highest price → descending.
  const asksAsc = asks.filter(l => l.notes > 0).sort((a, b) => a.priceBps - b.priceBps);
  const bidsDesc = bids.filter(l => l.notes > 0).sort((a, b) => b.priceBps - a.priceBps);

  if (asksAsc.length === 0 && bidsDesc.length === 0) {
    return (
      <div className="h-[132px] flex items-center justify-center text-muted text-[11px] mono">
        No depth data yet
      </div>
    );
  }

  // Cumulative depth per side (pure — safe under the React Compiler lint).
  const askPts: DepthPoint[] = asksAsc.map((l, i) => ({
    x: l.priceBps / 100,
    cum: asksAsc.slice(0, i + 1).reduce((s, lv) => s + lv.notes, 0),
  }));
  const bidPts: DepthPoint[] = bidsDesc.map((l, i) => ({
    x: l.priceBps / 100,
    cum: bidsDesc.slice(0, i + 1).reduce((s, lv) => s + lv.notes, 0),
  }));

  // x-domain: lowest bid → highest ask, with breathing room on the outer edges.
  const bestBidX = bidPts[0]?.x;
  const bestAskX = askPts[0]?.x;
  const lo = bidPts.length ? bidPts[bidPts.length - 1].x : (bestAskX as number) - 1;
  const hi = askPts.length ? askPts[askPts.length - 1].x : (bestBidX as number) + 1;
  const pad = Math.max((hi - lo) * 0.08, 0.05);
  const xMin = lo - pad, xMax = hi + pad;
  const mid = bestBidX != null && bestAskX != null ? (bestBidX + bestAskX) / 2 : (bestBidX ?? bestAskX);
  const x = (p: number) => PAD_L + ((p - xMin) / (xMax - xMin || 1)) * innerW;

  const maxCum = Math.max(
    askPts.length > 0 ? askPts[askPts.length - 1].cum : 0,
    bidPts.length > 0 ? bidPts[bidPts.length - 1].cum : 0,
    1,
  );
  const y = (n: number) => baseY - (n / maxCum) * innerH;

  /**
   * Step-after area path. `pts` must be ordered walking AWAY from the mid
   * (asks ascending, bids descending); the area starts at the mid price at
   * zero depth and extends to `outerX` at the final cumulative level.
   */
  const stepArea = (pts: DepthPoint[], outerX: number) => {
    if (pts.length === 0) return "";
    const fmt = (n: number) => n.toFixed(1);
    let d = `M ${fmt(x(mid))} ${baseY}`;
    d += ` L ${fmt(x(pts[0].x))} ${baseY}`;
    for (let i = 0; i < pts.length; i++) {
      const px = fmt(x(pts[i].x));
      d += ` L ${px} ${fmt(y(i === 0 ? 0 : pts[i - 1].cum))}`;
      d += ` L ${px} ${fmt(y(pts[i].cum))}`;
    }
    d += ` L ${fmt(outerX)} ${fmt(y(pts[pts.length - 1].cum))}`;
    d += ` L ${fmt(outerX)} ${baseY} Z`;
    return d;
  };

  const pct = (p: number) => `${p.toFixed(2)}%`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label="Order book depth chart">
      {/* horizontal grid */}
      {[0.25, 0.5, 0.75, 1].map(f => (
        <line key={f} x1={PAD_L} y1={y(maxCum * f)} x2={W - PAD_R} y2={y(maxCum * f)} stroke={GRID} strokeWidth={0.5} />
      ))}
      {/* y-axis label: max cumulative notes */}
      <text x={PAD_L - 4} y={y(maxCum) + 3} fontSize={8} fill={MUTED} textAnchor="end" className="mono">
        {maxCum.toLocaleString()}
      </text>
      <text x={PAD_L - 4} y={baseY + 3} fontSize={8} fill={MUTED} textAnchor="end" className="mono">0</text>

      {/* bid area (green, left of mid) */}
      {bidPts.length > 0 && (
        <path d={stepArea(bidPts, x(xMin))} fill={GREEN} fillOpacity={0.14} stroke={GREEN} strokeWidth={1.2} strokeLinejoin="round" />
      )}
      {/* ask area (red, right of mid) */}
      {askPts.length > 0 && (
        <path d={stepArea(askPts, x(xMax))} fill={RED} fillOpacity={0.14} stroke={RED} strokeWidth={1.2} strokeLinejoin="round" />
      )}

      {/* mid line */}
      <line x1={x(mid)} y1={PAD_T} x2={x(mid)} y2={baseY} stroke={INK} strokeWidth={0.7} strokeDasharray="3 3" opacity={0.55} />

      {/* x-axis: min / mid / max as % of par */}
      <text x={PAD_L} y={H - 6} fontSize={8} fill={MUTED} className="mono">{pct(xMin)}</text>
      <text x={x(mid)} y={H - 6} fontSize={8} fill={INK} textAnchor="middle" className="mono" fontWeight={700}>{pct(mid)}</text>
      <text x={W - PAD_R} y={H - 6} fontSize={8} fill={MUTED} textAnchor="end" className="mono">{pct(xMax)}</text>
    </svg>
  );
}

export default DepthChart;
