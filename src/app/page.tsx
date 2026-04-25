"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const [username, setUsername]     = useState("");
  const [password, setPassword]     = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError]           = useState("");
  const [loading, setLoading]       = useState(false);

  async function handleLogin() {
    setLoading(true); setError("");
    const { data, error } = await supabase
      .from("cyclic_users").select("*")
      .eq("username", username.trim().toLowerCase())
      .eq("password", password)
      .eq("is_active", true).maybeSingle();
    if (error || !data) {
      setError("Usuario o contraseña incorrectos.");
      setLoading(false); return;
    }
    localStorage.setItem("cyclic_user", JSON.stringify(data));
    window.location.href = "/dashboard";
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
      style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)" }}
    >
      {/* ── MARCA DE AGUA RASECORP ─────────────────────────── */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
        style={{ opacity: 0.06 }}
      >
        {/* Logo Rasecorp SVG inline — hexágono con R, tipografía y tagline */}
        <svg viewBox="0 0 520 400" xmlns="http://www.w3.org/2000/svg"
          className="w-[90vw] max-w-2xl"
        >
          {/* Hexágono exterior */}
          <polygon
            points="130,20 230,20 280,105 230,190 130,190 80,105"
            fill="none" stroke="white" strokeWidth="8"
          />
          {/* Hexágono interior */}
          <polygon
            points="135,32 225,32 270,105 225,178 135,178 90,105"
            fill="none" stroke="#f97316" strokeWidth="3"
          />
          {/* Letra R */}
          <text x="180" y="145" textAnchor="middle" fill="white"
            fontSize="110" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
          >R</text>
          {/* RASECORP */}
          <text x="310" y="115" textAnchor="start" fill="white"
            fontSize="72" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
            letterSpacing="-2"
          >RASE</text>
          <text x="310" y="182" textAnchor="start" fill="#f97316"
            fontSize="72" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif"
            letterSpacing="-2"
          >CORP</text>
          {/* Tagline */}
          <text x="160" y="235" textAnchor="middle" fill="white"
            fontSize="20" fontWeight="400" fontFamily="Arial, sans-serif"
            letterSpacing="6"
          >SOLUCIONES LOGÍSTICAS</text>
          {/* Líneas decorativas */}
          <line x1="80" y1="248" x2="130" y2="248" stroke="#f97316" strokeWidth="2"/>
          <line x1="190" y1="248" x2="240" y2="248" stroke="#f97316" strokeWidth="2"/>
          {/* Iconos servicios */}
          <text x="60"  y="310" textAnchor="middle" fill="white" fontSize="28">🏭</text>
          <text x="145" y="310" textAnchor="middle" fill="white" fontSize="28">📦</text>
          <text x="230" y="310" textAnchor="middle" fill="white" fontSize="28">🚚</text>
          <text x="315" y="310" textAnchor="middle" fill="white" fontSize="28">🔗</text>
          {/* Footer info */}
          <text x="180" y="370" textAnchor="middle" fill="white"
            fontSize="15" fontFamily="Arial, sans-serif" letterSpacing="1"
          >EFICIENCIA · CONFIANZA · COMPROMISO</text>
        </svg>
      </div>

      {/* ── PUNTOS DE LUZ DECORATIVOS ─────────────────────── */}
      <div className="absolute top-20 left-10 w-72 h-72 rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(249,115,22,0.12) 0%, transparent 70%)" }}
      />
      <div className="absolute bottom-20 right-10 w-96 h-96 rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)" }}
      />

      {/* ── CARD DE LOGIN ──────────────────────────────────── */}
      <div className="relative z-10 w-full max-w-sm space-y-5"
        style={{
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: "24px",
          padding: "36px 32px",
          boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
        }}
      >
        {/* Header */}
        <div className="text-center space-y-1 pb-2">
          <div className="flex items-center justify-center gap-2 mb-3">
            {/* Mini hexágono logo */}
            <svg viewBox="0 0 60 60" width="36" height="36">
              <polygon points="30,4 52,17 52,43 30,56 8,43 8,17"
                fill="none" stroke="#f97316" strokeWidth="3"/>
              <text x="30" y="40" textAnchor="middle" fill="white"
                fontSize="26" fontWeight="900" fontFamily="Arial Black, sans-serif">R</text>
            </svg>
            <div className="text-left">
              <p className="text-white font-black text-lg leading-none tracking-wide">RASECORP</p>
              <p className="text-orange-400 text-xs font-semibold tracking-widest leading-none mt-0.5">LOGÍSTICA</p>
            </div>
          </div>
          <h1 className="text-2xl font-bold text-white">Cíclicos</h1>
          <p className="text-slate-400 text-sm">Ingresa con tus credenciales</p>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-2xl p-3 text-sm text-red-300 font-medium flex items-center gap-2"
            style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}
          >
            <span>⚠️</span> {error}
          </div>
        )}

        {/* Usuario */}
        <div className="space-y-3">
          <input
            className="w-full rounded-2xl p-3 text-sm text-white placeholder-slate-400 outline-none transition-all"
            style={{
              background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.15)",
            }}
            placeholder="Usuario"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
            autoComplete="username"
          />

          {/* Contraseña */}
          <div className="relative">
            <input
              className="w-full rounded-2xl p-3 text-sm text-white placeholder-slate-400 outline-none pr-12 transition-all"
              style={{
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.15)",
              }}
              placeholder="Contraseña"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoComplete="current-password"
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-lg px-1 transition-colors"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? "🙈" : "👁️"}
            </button>
          </div>
        </div>

        {/* Botón ingresar */}
        <button
          className="w-full rounded-2xl p-3 font-bold text-sm transition-all disabled:opacity-50"
          style={{
            background: loading ? "rgba(249,115,22,0.6)" : "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
            color: "white",
            boxShadow: loading ? "none" : "0 4px 15px rgba(249,115,22,0.4)",
          }}
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
              </svg>
              Ingresando...
            </span>
          ) : "Ingresar"}
        </button>

        {/* Footer */}
        <p className="text-center text-slate-500 text-xs pt-1">
          © 2025 RaseCorp · Soluciones Logísticas
        </p>
      </div>
    </main>
  );
}