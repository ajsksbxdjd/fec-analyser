"use client";

import { downloadReport } from "@/lib/api";
import type { Summary } from "@/lib/types";

interface Props {
  summary: Summary;
}

type Intensity = "light" | "moderate" | "heavy";

function getIntensity(epg: number): Intensity {
  if (epg < 2000) return "light";
  if (epg < 4000) return "moderate";
  return "heavy";
}

const INTENSITY_CONFIG: Record<
  Intensity,
  { label: string; emoji: string; bg: string; text: string; border: string; bar: string }
> = {
  light: {
    label: "Light",
    emoji: "🟢",
    bg: "bg-green-50",
    text: "text-green-800",
    border: "border-green-200",
    bar: "bg-green-500",
  },
  moderate: {
    label: "Moderate",
    emoji: "🟡",
    bg: "bg-yellow-50",
    text: "text-yellow-800",
    border: "border-yellow-200",
    bar: "bg-yellow-400",
  },
  heavy: {
    label: "Heavy",
    emoji: "🔴",
    bg: "bg-red-50",
    text: "text-red-800",
    border: "border-red-200",
    bar: "bg-red-500",
  },
};

export default function SummaryDashboard({ summary }: Props) {
  const intensity = getIntensity(summary.epg);
  const cfg = INTENSITY_CONFIG[intensity];

  const handleDownload = async () => {
    try {
      const blob = await downloadReport(summary.batch_id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `batch-${summary.batch_id}-${summary.batch_name.replace(/\s+/g, "_")}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <MetricCard label="Total Eggs" value={summary.total_eggs} color="blue" />
        <MetricCard label="EPG (×24)" value={summary.epg} color="green" />
        <MetricCard label="Images Reviewed" value={summary.image_count} color="purple" />
      </div>

      {/* Infection intensity banner */}
      <div className={`border rounded-xl px-6 py-5 ${cfg.bg} ${cfg.border}`}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <p className={`text-xs font-semibold uppercase tracking-wide mb-1 ${cfg.text} opacity-70`}>
              Infection Intensity
            </p>
            <p className={`text-2xl font-bold flex items-center gap-2 ${cfg.text}`}>
              {cfg.emoji} {cfg.label} Infection
            </p>
            <p className={`text-sm mt-1 ${cfg.text} opacity-80`}>
              EPG = {summary.epg.toLocaleString()} eggs per gram
            </p>
          </div>

          {/* Scale indicator */}
          <div className="flex flex-col gap-1.5 min-w-[180px]">
            <div className="flex justify-between text-xs font-medium opacity-70">
              <span className={cfg.text}>0</span>
              <span className={cfg.text}>2,000</span>
              <span className={cfg.text}>4,000+</span>
            </div>
            <div className="relative h-3 rounded-full bg-white/60 overflow-hidden border border-white/40">
              {/* Colour zones */}
              <div className="absolute inset-y-0 left-0 w-1/2 bg-green-400/40 rounded-l-full" />
              <div className="absolute inset-y-0 left-1/2 w-1/4 bg-yellow-400/40" />
              <div className="absolute inset-y-0 left-3/4 right-0 bg-red-400/40 rounded-r-full" />
              {/* Needle */}
              <div
                className={`absolute top-0 h-full w-1 rounded-full ${cfg.bar} shadow`}
                style={{
                  left: `${Math.min(Math.round((summary.epg / 6000) * 100), 98)}%`,
                  transform: "translateX(-50%)",
                }}
              />
            </div>
            <div className="flex justify-between text-xs opacity-60">
              <span className={cfg.text}>🟢 Light</span>
              <span className={cfg.text}>🟡 Mod</span>
              <span className={cfg.text}>🔴 Heavy</span>
            </div>
          </div>
        </div>

        {/* Threshold legend */}
        <div className={`mt-4 pt-3 border-t ${cfg.border} grid grid-cols-3 gap-2 text-xs ${cfg.text}`}>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${intensity === "light" ? "bg-white/50 font-bold ring-1 ring-green-400" : "opacity-60"}`}>
            🟢 Light &lt; 2,000
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${intensity === "moderate" ? "bg-white/50 font-bold ring-1 ring-yellow-400" : "opacity-60"}`}>
            🟡 Moderate 2,000–3,999
          </div>
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md ${intensity === "heavy" ? "bg-white/50 font-bold ring-1 ring-red-400" : "opacity-60"}`}>
            🔴 Heavy ≥ 4,000
          </div>
        </div>
      </div>

      {/* Per-image table */}
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-700">Per-image Egg Counts</h2>
          <button
            onClick={handleDownload}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white text-xs font-medium rounded-md hover:bg-green-700 transition-colors"
          >
            ↓ Download CSV
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left">#</th>
                <th className="px-4 py-2 text-left">Filename</th>
                <th className="px-4 py-2 text-right">Egg Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.images.map((row, idx) => (
                <tr key={row.image_id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-400">{idx + 1}</td>
                  <td className="px-4 py-2 text-gray-700 truncate max-w-xs">{row.filename}</td>
                  <td className="px-4 py-2 text-right font-medium text-gray-900">
                    {row.egg_count}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 font-semibold text-gray-700">
              <tr>
                <td colSpan={2} className="px-4 py-2">Total Eggs</td>
                <td className="px-4 py-2 text-right text-blue-700">{summary.total_eggs}</td>
              </tr>
              <tr>
                <td colSpan={2} className="px-4 py-2">EPG (×24)</td>
                <td className="px-4 py-2 text-right text-green-700 text-base">{summary.epg}</td>
              </tr>
              <tr>
                <td colSpan={2} className="px-4 py-2">Infection Intensity</td>
                <td className="px-4 py-2 text-right">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.bg} ${cfg.text} border ${cfg.border}`}>
                    {cfg.emoji} {cfg.label}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "blue" | "green" | "purple";
}) {
  const palette = {
    blue: "bg-blue-50 text-blue-700 border-blue-100",
    green: "bg-green-50 text-green-700 border-green-100",
    purple: "bg-purple-50 text-purple-700 border-purple-100",
  };
  return (
    <div className={`border rounded-xl px-5 py-4 ${palette[color]}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-3xl font-bold mt-1">{value.toLocaleString()}</p>
    </div>
  );
}
