import { useEffect, useMemo, useRef, useState } from "react";

export interface ChartSpec {
  type: "bar" | "line";
  x: string;
  y: string[];
}

const H = 260;
const M = { top: 12, right: 16, bottom: 40, left: 56 };
const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

/** Round axis ticks: 0 … a "nice" maximum in 4–5 steps. */
function niceTicks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = max <= lo ? lo + 1 : max;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 0.001; v += step) ticks.push(Number(v.toFixed(10)));
  if (ticks[ticks.length - 1]! < hi) ticks.push(ticks[ticks.length - 1]! + step);
  return ticks;
}

const isDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
const asDate = (v: string) => new Date(v.length === 10 ? `${v}T00:00:00` : v);

/** Label format follows the data: months when every date is the 1st, otherwise days. */
function label(v: unknown, monthly = false): string {
  if (isDate(v)) {
    const d = asDate(v);
    return monthly ? d.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return v === null || v === undefined ? "—" : String(v);
}

const human = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/**
 * One measure at a time on one axis (several measures of different scale are never mixed — a
 * switch chooses which one is shown). Bars compare categories; a line shows change over time.
 * Every mark has a hover tooltip; the full numbers are in the table below the chart.
 */
export function AnswerChart({ spec, rows }: { spec: ChartSpec; rows: Record<string, unknown>[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [measure, setMeasure] = useState(spec.y[0]!);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setMeasure(spec.y[0]!), [spec]);
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.floor(e!.contentRect.width))));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const values = useMemo(() => rows.map((r) => (typeof r[measure] === "number" ? (r[measure] as number) : Number(r[measure]) || 0)), [rows, measure]);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const y0 = ticks[0]!;
  const y1 = ticks[ticks.length - 1]!;
  const plotW = width - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const y = (v: number) => M.top + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH;
  const n = rows.length;
  const band = plotW / n;
  const xCenter = (i: number) => (spec.type === "bar" ? M.left + band * i + band / 2 : M.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)));
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const title = `${human(measure)} by ${human(spec.x).toLowerCase()}`;
  const monthly = rows.every((r) => isDate(r[spec.x]) && asDate(r[spec.x] as string).getDate() === 1);

  const barW = Math.max(2, Math.min(48, band - 2));
  const barPath = (i: number) => {
    const v = values[i]!;
    const x = xCenter(i) - barW / 2;
    const zero = y(0);
    const end = y(v);
    const h = Math.abs(zero - end);
    const r = Math.min(4, barW / 2, h);
    // Rounded at the data end, square on the baseline (upwards for positive values, downwards for negative).
    const dir = v >= 0 ? 1 : -1;
    return `M${x},${zero} V${end + dir * r} Q${x},${end} ${x + r},${end} H${x + barW - r} Q${x + barW},${end} ${x + barW},${end + dir * r} V${zero} Z`;
  };
  const linePath = values.map((v, i) => `${i ? "L" : "M"}${xCenter(i)},${y(v)}`).join(" ");

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * plotW;
    const i = spec.type === "bar" ? Math.floor(px / band) : Math.round((px / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <figure className="answer-chart">
      <div className="answer-chart-head">
        <figcaption>{title}</figcaption>
        {spec.y.length > 1 && (
          <div className="segmented" role="radiogroup" aria-label="Measure shown">
            {spec.y.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={measure === m} className={measure === m ? "active" : ""} onClick={() => setMeasure(m)}>
                {human(m)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="answer-chart-box" ref={box}>
        <svg width={width} height={H} role="img" aria-label={`${spec.type === "bar" ? "Bar" : "Line"} chart: ${title}. The numbers are in the table below.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis-line" : "grid-line"} />
              <text x={M.left - 8} y={y(t)} className="tick" textAnchor="end" dominantBaseline="middle">{compact.format(t)}</text>
            </g>
          ))}
          {rows.map((r, i) =>
            i % every === 0 ? (
              <text key={i} x={xCenter(i)} y={H - M.bottom + 16} className="tick" textAnchor="middle">
                {label(r[spec.x], monthly).slice(0, 14)}
              </text>
            ) : null,
          )}
          {spec.type === "bar"
            ? values.map((_, i) => <path key={i} d={barPath(i)} className={`bar ${hover === i ? "active" : ""}`} />)
            : (
              <>
                <path d={linePath} className="line" />
                {hover !== null && <line x1={xCenter(hover)} x2={xCenter(hover)} y1={M.top} y2={M.top + plotH} className="crosshair" />}
                {(hover !== null ? [hover] : n <= 2 ? values.map((_, i) => i) : [n - 1]).map((i) => <circle key={i} cx={xCenter(i)} cy={y(values[i]!)} r={4.5} className="point" />)}
              </>
            )}
          <rect x={M.left} y={M.top} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: Math.min(width - 160, Math.max(0, xCenter(hover) - 70)), top: Math.max(0, y(Math.max(values[hover]!, 0)) - 58) }} role="status">
            <span className="muted small">{label(rows[hover]![spec.x], monthly)}</span>
            <strong className="num">{full.format(values[hover]!)}</strong>
            <span className="small secondary">{human(measure)}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
