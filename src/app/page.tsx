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
    <main className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-xl p-8 w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cíclicos</h1>
          <p className="text-slate-500 text-sm mt-1">Conteos cíclicos</p>
        </div>
        {error && (
          <div className="bg-red-50 text-red-700 rounded-2xl p-3 text-sm">{error}</div>
        )}
        <input
          className="w-full border rounded-2xl p-3 text-sm"
          placeholder="Usuario"
          value={username}
          onChange={e => setUsername(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleLogin()}
        />
        <div className="relative">
          <input
            className="w-full border rounded-2xl p-3 text-sm pr-12"
            placeholder="Contraseña"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleLogin()}
          />
          <button
            type="button"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 text-lg px-1"
            onClick={() => setShowPassword(!showPassword)}
          >
            {showPassword ? "🙈" : "👁️"}
          </button>
        </div>
        <button
          className="w-full bg-slate-900 text-white rounded-2xl p-3 font-semibold"
          onClick={handleLogin}
          disabled={loading}
        >
          {loading ? "Ingresando..." : "Ingresar"}
        </button>
      </div>
    </main>
  );
}