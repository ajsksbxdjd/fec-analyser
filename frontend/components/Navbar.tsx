import Link from "next/link";
import { Microscope, Plus } from "lucide-react";

export default function Navbar() {
  return (
    <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
      <Link
        href="/batches"
        className="flex items-center gap-2 text-sm font-semibold text-slate-900 tracking-tight"
      >
        <Microscope size={18} className="text-blue-600" strokeWidth={1.75} />
        FEC Analyser
      </Link>
      <div className="flex items-center gap-3">
        <Link
          href="/batches"
          className="inline-flex items-center gap-1.5 text-xs font-semibold bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus size={13} strokeWidth={2.5} />
          New analysis
        </Link>
      </div>
    </nav>
  );
}
