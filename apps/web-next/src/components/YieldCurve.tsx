"use client";

/**
 * Term-structure view of the exchange: best ask APY per market, plotted as
 * an SVG line + dots with x = maturity (days) and y = APY %.
 *
 * Props are plain shapes so the page can pass its locally-declared types
 * structurally. Pure render — no state, no network.
 */

const GREEN = "#1fad60";
const GRID = "#ece8e3";
const MUTED = "#9a928a";
const INK = "#151514";

export interface YieldCurveListing {
  market: string;
  askPriceUsd: number;
  yieldBps: number;
}

export interface YieldCurveMarket {
  symbol: string;
  maturityDays: number;
}

interface CurvePoint {
  symbol: string;
  days: number;
  apy: number;
}

export function YieldCurve({ listings, markets }: {
  listings: YieldCurveListing[];
  markets: YieldCurveMarket[];
}) {
  const W = 760, H = 200;
  const PAD_L = 46, PAD_R = 24, PAD_T = 22, PAD_B = 30;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Best ask per market = lowest ask price (ties keep the first, i.e. the
  // highest-yielding one when equal prices). APY% = yieldBps / 100.
  const best = new Map<string, { ask: number; apy: number }>();
  for (const l of listings) {
    const cur = best.get(l.market);
    if (!cur || l.askPriceUsd < cur.ask) best.set(l.market, { ask: l.askPriceUsd, apy: l.yieldBps / 100 });
  }
  const daysBySymbol = new Map(markets.map(m => [m.symbol, m.maturityDays]));
  const points: CurvePoint[] = [...best.entries()]
    .filter(([sym]) => daysBySymbol.has(sym))
    .map(([sym, b]) => ({ symbol: sym, days: daysBySymbol.get(sym) as number, apy: b.apy }))
    .sort((a, b) => a.days - b.days);

  if (points.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted text-sm">
        No active asks yet — the curve plots each market&apos;s best ask APY.
      </div>
    );
  }

  // x-domain: maturity days, padded so edge dots don't clip.
  const dMin = points[0].days, dMax = points[points.length - 1].days;
  const dPad = Math.max((dMax - dMin) * 0.12, 2);
  const xMin = Math.max(0, dMin - dPad), xMax = dMax + dPad;
  const x = (d: number) => PAD_L + ((d - xMin) / (xMax - xMin || 1)) * innerW;

  // y-domain: APY range, padded (flat range still gets ±0.5% of headroom).
  const apys = points.map(p => p.apy);
  const aMin = Math.min(...apys), aMax = Math.max(...apys);
  const aPad = Math.max((aMax - aMin) * 0.15, 0.5);
  const yMin = aMin - aPad, yMax = aMax + aPad;
  const y = (a: number) => PAD_T + (1 - (a - yMin) / (yMax - yMin || 1)) * innerH;

  const gridLines = 4;
  const linePts = points.map(p => `${x(p.days).toFixed(1)},${y(p.apy).toFixed(1)}`).join(" ");
  const fmtApy = (v: number) => `${v.toFixed(1)}%`;
  const fmtDays = (d: number) => `${d}d`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label="Yield curve: best ask APY per market by maturity">
      {/* APY grid + y labels (mono) */}
      {Array.from({ length: gridLines + 1 }, (_, i) => {
        const a = yMin + ((yMax - yMin) * i) / gridLines;
        const yy = y(a);
        return (
          <g key={i}>
            <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={GRID} strokeWidth={0.5} />
            <text x={PAD_L - 6} y={yy + 3} fontSize={9} fill={MUTED} textAnchor="end" className="mono">{fmtApy(a)}</text>
          </g>
        );
      })}
      {/* x labels (mono): first / mid / last maturity */}
      <text x={x(points[0].days)} y={H - 8} fontSize={9} fill={MUTED} textAnchor="middle" className="mono">{fmtDays(points[0].days)}</text>
      {points.length > 2 && (
        <text x={x(points[Math.floor((points.length - 1) / 2)].days)} y={H - 8} fontSize={9} fill={MUTED} textAnchor="middle" className="mono">
          {fmtDays(points[Math.floor((points.length - 1) / 2)].days)}
        </text>
      )}
      <text x={x(points[points.length - 1].days)} y={H - 8} fontSize={9} fill={MUTED} textAnchor="middle" className="mono">{fmtDays(points[points.length - 1].days)}</text>

      {/* curve + dots */}
      {points.length > 1 && (
        <polyline points={linePts} fill="none" stroke={GREEN} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      )}
      {points.map(p => (
        <g key={p.symbol}>
          <circle cx={x(p.days)} cy={y(p.apy)} r={3.5} fill={GREEN} stroke="#fff" strokeWidth={1} />
          <text x={x(p.days)} y={y(p.apy) - 8} fontSize={9} fill={INK} textAnchor="middle" className="mono" fontWeight={700}>
            {p.symbol}
          </text>
          <text x={x(p.days)} y={y(p.apy) + 13} fontSize={8} fill={MUTED} textAnchor="middle" className="mono">
            {fmtApy(p.apy)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default YieldCurve;
