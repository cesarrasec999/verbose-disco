"use client";

export function SidebarBrand() {
  return (
    <div className="px-5 py-5 border-b border-slate-700/60">
      <div className="flex items-center gap-2.5">
        <div
          style={{
            background: "linear-gradient(135deg, #f97316 0%, #c2410c 100%)",
            borderRadius: "10px",
            padding: "6px 8px",
          }}
        >
          <svg viewBox="0 0 60 60" width="24" height="24">
            <polygon points="30,3 54,17 54,43 30,57 6,43 6,17" fill="rgba(255,255,255,0.15)" />
            <text x="30" y="42" textAnchor="middle" fill="white" fontSize="32" fontWeight="900" fontFamily="Arial Black, sans-serif">R</text>
          </svg>
        </div>
        <div>
          <p className="font-black text-sm leading-none tracking-wider">
            RASE<span style={{ color: "#f97316" }}>CORP</span>
          </p>
          <p className="text-slate-400 text-[10px] leading-none mt-1 tracking-widest">CICLICOS</p>
        </div>
      </div>
    </div>
  );
}
