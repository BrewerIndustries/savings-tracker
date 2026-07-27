"use client";

import { ACCENT, type AccentKey } from "@/lib/types";

/**
 * A vertical thermometer drawn in SVG: a rounded tube with a bulb at the bottom,
 * mercury that fills from the bulb up to `progress`, and 25/50/75/100 ticks.
 * Used for the overall "all goals" hero. Fill is clamped to 100% visually even
 * when overfunded; the real percentage is shown by the caller.
 */
export function VerticalThermometer({
  progress,
  accent = "green",
  height = 340,
}: {
  progress: number;
  accent?: AccentKey;
  height?: number;
}) {
  const p = Math.max(0, Math.min(1, progress));
  const color = ACCENT[accent].dot;

  // Geometry (viewBox units).
  const W = 130;
  const cx = 46; // tube + bulb centre x
  const tubeW = 30;
  const topY = 22; // top of scale (100%)
  const zeroY = height - 66; // bottom of scale (0%), just above the bulb
  const bulbCY = height - 26;
  const bulbR = 26;

  const span = zeroY - topY;
  const fillTop = zeroY - p * span;

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      style={{ maxWidth: 130, display: "block" }}
      role="img"
      aria-label={`${Math.round(progress * 100)} percent of total goal`}
    >
      {/* track tube */}
      <rect
        x={cx - tubeW / 2}
        y={topY}
        width={tubeW}
        height={zeroY - topY + 14}
        rx={tubeW / 2}
        fill="#eceae2"
        stroke="#e0ded4"
      />
      {/* bulb track */}
      <circle cx={cx} cy={bulbCY} r={bulbR} fill="#eceae2" stroke="#e0ded4" />

      {/* mercury fill (bulb + column) */}
      <circle cx={cx} cy={bulbCY} r={bulbR - 4} fill={color} />
      <rect
        className="merc"
        x={cx - (tubeW - 8) / 2}
        y={fillTop}
        width={tubeW - 8}
        height={zeroY - fillTop + 10}
        rx={(tubeW - 8) / 2}
        fill={color}
      />

      {/* ticks + labels */}
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = zeroY - t * span;
        return (
          <g key={t}>
            <line x1={cx + tubeW / 2 + 3} y1={y} x2={cx + tubeW / 2 + 10} y2={y}
              stroke="#b9b6ab" strokeWidth={1.5} />
            <text x={cx + tubeW / 2 + 14} y={y + 4} fontSize={11} fill="#6b6b63">
              {Math.round(t * 100)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * A compact horizontal thermometer for a goal card: a rounded tube with a small
 * bulb on the left and a fill that grows rightward in the goal's accent colour.
 */
export function ThermoBar({
  progress,
  accent = "green",
}: {
  progress: number;
  accent?: AccentKey;
}) {
  const p = Math.max(0, Math.min(1, progress));
  const color = ACCENT[accent].dot;
  return (
    <div className="flex items-center gap-2" aria-hidden>
      <span
        className="shrink-0 rounded-full"
        style={{ width: 14, height: 14, background: color }}
      />
      <div
        className="relative flex-1 rounded-full overflow-hidden"
        style={{ height: 14, background: "#eceae2", border: "1px solid #e0ded4" }}
      >
        <div
          className="bar-fill absolute left-0 top-0 bottom-0 rounded-full"
          style={{ width: `${p * 100}%`, background: color }}
        />
      </div>
    </div>
  );
}
