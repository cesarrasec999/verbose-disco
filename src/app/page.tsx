"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase/client";

type CyclicUser = {
    id: string;
    username: string;
    password?: string;
    full_name: string;
    role: string;
    store_id: string | null;
    can_access_all_stores: boolean;
    is_active: boolean;
    whatsapp?: string | null;
};

export default function LoginPage() {
    const [username, setUsername]         = useState("");
    const [password, setPassword]         = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError]               = useState("");
    const [loading, setLoading]           = useState(false);

    // Modal: pedir WhatsApp + cambiar contraseña
    const [pendingUser, setPendingUser]           = useState<CyclicUser | null>(null);
    const [modalMode, setModalMode]               = useState<"whatsapp" | "changepass" | null>(null);
    const [wspInput, setWspInput]                 = useState("");
    const [newPass, setNewPass]                   = useState("");
    const [confirmPass, setConfirmPass]           = useState("");
    const [newWspInput, setNewWspInput]           = useState("");
    const [showNewPass, setShowNewPass]           = useState(false);
    const [showConfirmPass, setShowConfirmPass]   = useState(false);
    const [modalError, setModalError]             = useState("");
    const [modalLoading, setModalLoading]         = useState(false);

    async function handleLogin() {
        setLoading(true);
        setError("");
        const { data, error: dbError } = await supabase
            .from("cyclic_users")
            .select("*")
            .eq("username", username.trim().toLowerCase())
            .eq("password", password)
            .eq("is_active", true)
            .maybeSingle();

        if (dbError || !data) {
            setError("Usuario o contraseña incorrectos.");
            setLoading(false);
            return;
        }

        const user = data as CyclicUser;

        // Si no tiene WhatsApp, pedir antes de entrar
        if (!user.whatsapp) {
            setPendingUser(user);
            setModalMode("whatsapp");
            setLoading(false);
            return;
        }

        localStorage.setItem("cyclic_user", JSON.stringify(user));
        window.location.href = "/dashboard";
    }

    async function handleSaveWhatsapp() {
        if (!pendingUser) return;
        setModalError("");
        const wsp = wspInput.trim().replace(/\D/g, "");
        if (!wsp || wsp.length < 10) {
            setModalError("Ingresa un número válido con código de país (ej: 51987654321).");
            return;
        }
        setModalLoading(true);
        const { error: upErr } = await supabase
            .from("cyclic_users")
            .update({ whatsapp: wsp })
            .eq("id", pendingUser.id);

        if (upErr) {
            setModalError("Error al guardar el número. Intenta de nuevo.");
            setModalLoading(false);
            return;
        }
        const updatedUser = { ...pendingUser, whatsapp: wsp };
        localStorage.setItem("cyclic_user", JSON.stringify(updatedUser));
        setModalLoading(false);
        window.location.href = "/dashboard";
    }

    async function handleChangePassword() {
        if (!pendingUser) return;
        setModalError("");
        if (!newPass || newPass.length < 4) {
            setModalError("La contraseña debe tener al menos 4 caracteres.");
            return;
        }
        if (newPass !== confirmPass) {
            setModalError("Las contraseñas no coinciden.");
            return;
        }
        setModalLoading(true);

        const updateData: Record<string, string> = { password: newPass };
        const wsp = newWspInput.trim().replace(/\D/g, "");
        if (wsp) {
            if (wsp.length < 10) {
                setModalError("Ingresa un número de WhatsApp válido con código de país.");
                setModalLoading(false);
                return;
            }
            updateData.whatsapp = wsp;
        }

        const { error: upErr } = await supabase
            .from("cyclic_users")
            .update(updateData)
            .eq("id", pendingUser.id);

        if (upErr) {
            setModalError("Error al actualizar. Intenta de nuevo.");
            setModalLoading(false);
            return;
        }
        const updatedUser = { ...pendingUser, password: newPass, whatsapp: wsp || pendingUser.whatsapp };
        localStorage.setItem("cyclic_user", JSON.stringify(updatedUser));
        setModalLoading(false);
        window.location.href = "/dashboard";
    }

    return (
        <main
            className="min-h-screen flex items-center justify-center p-4 relative overflow-hidden"
            style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%)" }}
        >
            {/* ── MARCA DE AGUA RASECORP ─────────────────────────── */}
            <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
                style={{ opacity: 0.10 }}
            >
                <svg viewBox="0 0 520 400" xmlns="http://www.w3.org/2000/svg" className="w-[90vw] max-w-2xl">
                    {/* Hexágono exterior */}
                    <polygon points="130,20 230,20 280,105 230,190 130,190 80,105"
                        fill="none" stroke="white" strokeWidth="8" />
                    {/* Hexágono interior naranja */}
                    <polygon points="135,32 225,32 270,105 225,178 135,178 90,105"
                        fill="none" stroke="#f97316" strokeWidth="3" />
                    {/* Letra R grande */}
                    <text x="180" y="145" textAnchor="middle" fill="white"
                        fontSize="110" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif">R</text>
                    {/* RASE en blanco */}
                    <text x="310" y="115" textAnchor="start" fill="white"
                        fontSize="72" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif" letterSpacing="-2">RASE</text>
                    {/* CORP en naranja */}
                    <text x="310" y="182" textAnchor="start" fill="#f97316"
                        fontSize="72" fontWeight="900" fontFamily="Arial Black, Arial, sans-serif" letterSpacing="-2">CORP</text>
                    {/* Tagline */}
                    <text x="160" y="235" textAnchor="middle" fill="white"
                        fontSize="20" fontWeight="400" fontFamily="Arial, sans-serif" letterSpacing="6">SOLUCIONES LOGÍSTICAS</text>
                    {/* Líneas decorativas */}
                    <line x1="80" y1="248" x2="130" y2="248" stroke="#f97316" strokeWidth="2" />
                    <line x1="190" y1="248" x2="240" y2="248" stroke="#f97316" strokeWidth="2" />
                    {/* Iconos servicios */}
                    <text x="60"  y="310" textAnchor="middle" fill="white" fontSize="28">🏭</text>
                    <text x="145" y="310" textAnchor="middle" fill="white" fontSize="28">📦</text>
                    <text x="230" y="310" textAnchor="middle" fill="white" fontSize="28">🚚</text>
                    <text x="315" y="310" textAnchor="middle" fill="white" fontSize="28">🔗</text>
                    {/* Footer */}
                    <text x="180" y="370" textAnchor="middle" fill="white"
                        fontSize="15" fontFamily="Arial, sans-serif" letterSpacing="1">EFICIENCIA · CONFIANZA · COMPROMISO</text>
                </svg>
            </div>

            {/* ── PUNTOS DE LUZ DECORATIVOS ─────────────────────── */}
            <div className="absolute top-20 left-10 w-72 h-72 rounded-full pointer-events-none"
                style={{ background: "radial-gradient(circle, rgba(249,115,22,0.12) 0%, transparent 70%)" }} />
            <div className="absolute bottom-20 right-10 w-96 h-96 rounded-full pointer-events-none"
                style={{ background: "radial-gradient(circle, rgba(99,102,241,0.1) 0%, transparent 70%)" }} />

            {/* ── CARD DE LOGIN ──────────────────────────────────── */}
            <div
                className="relative z-10 w-full max-w-sm space-y-5"
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
                {/* Header con logo mejorado */}
                <div className="text-center space-y-1 pb-2">
                    <div className="flex items-center justify-center gap-3 mb-3">
                        {/* Logo hexagonal más visible */}
                        <div style={{
                            background: "linear-gradient(135deg, #1e3a5f 0%, #0f2744 100%)",
                            borderRadius: "14px",
                            padding: "8px",
                            boxShadow: "0 4px 16px rgba(249,115,22,0.35), 0 0 0 2px rgba(249,115,22,0.5)"
                        }}>
                            <svg viewBox="0 0 60 60" width="44" height="44">
                                {/* Fondo naranja del hexágono */}
                                <polygon points="30,3 54,17 54,43 30,57 6,43 6,17"
                                    fill="url(#hexGrad)" />
                                <defs>
                                    <linearGradient id="hexGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                        <stop offset="0%" stopColor="#f97316" />
                                        <stop offset="100%" stopColor="#c2410c" />
                                    </linearGradient>
                                </defs>
                                {/* Borde exterior blanco */}
                                <polygon points="30,3 54,17 54,43 30,57 6,43 6,17"
                                    fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" />
                                {/* Letra R blanca en negrita */}
                                <text x="30" y="42" textAnchor="middle" fill="white"
                                    fontSize="32" fontWeight="900" fontFamily="Arial Black, sans-serif"
                                    style={{ textShadow: "0 2px 4px rgba(0,0,0,0.3)" }}>R</text>
                            </svg>
                        </div>
                        <div className="text-left">
                            <p className="text-white font-black text-xl leading-none tracking-widest"
                                style={{ textShadow: "0 2px 8px rgba(249,115,22,0.4)" }}>
                                RASE<span style={{ color: "#f97316" }}>CORP</span>
                            </p>
                            <p className="text-slate-300 text-xs font-semibold tracking-widest leading-none mt-1">
                                SOLUCIONES LOGÍSTICAS
                            </p>
                        </div>
                    </div>
                    <h1 className="text-2xl font-bold text-white">Cíclicos</h1>
                    <p className="text-slate-400 text-sm">Ingresa con tus credenciales</p>
                </div>

                {/* Error */}
                {error && (
                    <div className="rounded-2xl p-3 text-sm text-red-300 font-medium flex items-center gap-2"
                        style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}>
                        <span>⚠️</span> {error}
                    </div>
                )}

                {/* Campos */}
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

                {/* Botón cambiar contraseña */}
                <div className="text-center">
                    <button
                        type="button"
                        className="text-xs text-orange-400 hover:text-orange-300 underline transition-colors"
                        onClick={() => {
                            if (!username.trim() || !password) {
                                setError("Ingresa usuario y contraseña primero para cambiarla.");
                                return;
                            }
                            // Verificar credenciales y abrir modal cambio de contraseña
                            setLoading(true);
                            setError("");
                            supabase
                                .from("cyclic_users")
                                .select("*")
                                .eq("username", username.trim().toLowerCase())
                                .eq("password", password)
                                .eq("is_active", true)
                                .maybeSingle()
                                .then(({ data, error: dbError }) => {
                                    setLoading(false);
                                    if (dbError || !data) {
                                        setError("Usuario o contraseña incorrectos.");
                                        return;
                                    }
                                    setPendingUser(data as CyclicUser);
                                    setNewWspInput((data as CyclicUser).whatsapp || "");
                                    setModalMode("changepass");
                                });
                        }}
                    >
                        Cambiar contraseña
                    </button>
                </div>

                {/* Botón ingresar */}
                <button
                    className="w-full rounded-2xl p-3 font-bold text-sm transition-all disabled:opacity-50"
                    style={{
                        background: loading
                            ? "rgba(249,115,22,0.6)"
                            : "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
                        color: "white",
                        boxShadow: loading ? "none" : "0 4px 15px rgba(249,115,22,0.4)",
                    }}
                    onClick={handleLogin}
                    disabled={loading}
                >
                    {loading ? (
                        <span className="flex items-center justify-center gap-2">
                            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
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

            {/* ════════════════════════════════════════════════════════
                MODAL — REGISTRAR WHATSAPP (primera vez)
            ════════════════════════════════════════════════════════ */}
            {modalMode === "whatsapp" && pendingUser && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div
                        className="w-full max-w-sm space-y-5"
                        style={{
                            background: "rgba(15,23,42,0.98)",
                            backdropFilter: "blur(20px)",
                            border: "1px solid rgba(249,115,22,0.3)",
                            borderRadius: "24px",
                            padding: "32px 28px",
                            boxShadow: "0 25px 50px rgba(0,0,0,0.7)",
                        }}
                    >
                        <div className="text-center space-y-2">
                            <div className="text-4xl">📲</div>
                            <h2 className="text-xl font-bold text-white">Registra tu WhatsApp</h2>
                            <p className="text-slate-400 text-sm">
                                Hola <b className="text-white">{pendingUser.full_name}</b>, para continuar necesitamos tu número de WhatsApp.
                                Este número se usará para enviarte las asignaciones de conteo.
                            </p>
                        </div>

                        {modalError && (
                            <div className="rounded-2xl p-3 text-sm text-red-300 font-medium flex items-center gap-2"
                                style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}>
                                <span>⚠️</span> {modalError}
                            </div>
                        )}

                        <div className="space-y-2">
                            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                                Número WhatsApp (con código de país)
                            </label>
                            <input
                                className="w-full rounded-2xl p-3 text-sm text-white placeholder-slate-500 outline-none"
                                style={{
                                    background: "rgba(255,255,255,0.08)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                }}
                                placeholder="Ej: 51987654321"
                                value={wspInput}
                                onChange={e => setWspInput(e.target.value)}
                                onKeyDown={e => e.key === "Enter" && handleSaveWhatsapp()}
                                inputMode="numeric"
                                autoFocus
                            />
                            <p className="text-xs text-slate-500">
                                Incluye el código de país sin el signo +. Perú: 51 + tu número (ej: 51987654321).
                            </p>
                        </div>

                        <button
                            className="w-full rounded-2xl p-3 font-bold text-sm transition-all disabled:opacity-50"
                            style={{
                                background: modalLoading
                                    ? "rgba(249,115,22,0.6)"
                                    : "linear-gradient(135deg, #f97316 0%, #ea580c 100%)",
                                color: "white",
                                boxShadow: modalLoading ? "none" : "0 4px 15px rgba(249,115,22,0.4)",
                            }}
                            onClick={handleSaveWhatsapp}
                            disabled={modalLoading}
                        >
                            {modalLoading ? (
                                <span className="flex items-center justify-center gap-2">
                                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                    </svg>
                                    Guardando...
                                </span>
                            ) : "Guardar y entrar"}
                        </button>
                    </div>
                </div>
            )}

            {/* ════════════════════════════════════════════════════════
                MODAL — CAMBIAR CONTRASEÑA (+ WhatsApp)
            ════════════════════════════════════════════════════════ */}
            {modalMode === "changepass" && pendingUser && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div
                        className="w-full max-w-sm space-y-5"
                        style={{
                            background: "rgba(15,23,42,0.98)",
                            backdropFilter: "blur(20px)",
                            border: "1px solid rgba(99,102,241,0.3)",
                            borderRadius: "24px",
                            padding: "32px 28px",
                            boxShadow: "0 25px 50px rgba(0,0,0,0.7)",
                        }}
                    >
                        <div className="text-center space-y-2">
                            <div className="text-4xl">🔐</div>
                            <h2 className="text-xl font-bold text-white">Cambiar contraseña</h2>
                            <p className="text-slate-400 text-sm">
                                <b className="text-white">{pendingUser.full_name}</b>, elige tu nueva contraseña y actualiza también tu WhatsApp si deseas.
                            </p>
                        </div>

                        {modalError && (
                            <div className="rounded-2xl p-3 text-sm text-red-300 font-medium flex items-center gap-2"
                                style={{ background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.3)" }}>
                                <span>⚠️</span> {modalError}
                            </div>
                        )}

                        <div className="space-y-3">
                            {/* Nueva contraseña */}
                            <div>
                                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                                    Nueva contraseña
                                </label>
                                <div className="relative">
                                    <input
                                        className="w-full rounded-2xl p-3 text-sm text-white placeholder-slate-500 outline-none pr-12"
                                        style={{
                                            background: "rgba(255,255,255,0.08)",
                                            border: "1px solid rgba(255,255,255,0.15)",
                                        }}
                                        placeholder="Mínimo 4 caracteres"
                                        type={showNewPass ? "text" : "password"}
                                        value={newPass}
                                        onChange={e => setNewPass(e.target.value)}
                                        autoFocus
                                    />
                                    <button
                                        type="button"
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-lg px-1"
                                        onClick={() => setShowNewPass(!showNewPass)}
                                    >
                                        {showNewPass ? "🙈" : "👁️"}
                                    </button>
                                </div>
                            </div>

                            {/* Confirmar contraseña */}
                            <div>
                                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                                    Confirmar nueva contraseña
                                </label>
                                <div className="relative">
                                    <input
                                        className="w-full rounded-2xl p-3 text-sm text-white placeholder-slate-500 outline-none pr-12"
                                        style={{
                                            background: "rgba(255,255,255,0.08)",
                                            border: "1px solid rgba(255,255,255,0.15)",
                                        }}
                                        placeholder="Repite la contraseña"
                                        type={showConfirmPass ? "text" : "password"}
                                        value={confirmPass}
                                        onChange={e => setConfirmPass(e.target.value)}
                                        onKeyDown={e => e.key === "Enter" && handleChangePassword()}
                                    />
                                    <button
                                        type="button"
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white text-lg px-1"
                                        onClick={() => setShowConfirmPass(!showConfirmPass)}
                                    >
                                        {showConfirmPass ? "🙈" : "👁️"}
                                    </button>
                                </div>
                            </div>

                            {/* WhatsApp — siempre se pide al cambiar contraseña */}
                            <div>
                                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-1">
                                    WhatsApp (actualizar)
                                </label>
                                <input
                                    className="w-full rounded-2xl p-3 text-sm text-white placeholder-slate-500 outline-none"
                                    style={{
                                        background: "rgba(255,255,255,0.08)",
                                        border: "1px solid rgba(255,255,255,0.15)",
                                    }}
                                    placeholder="Ej: 51987654321"
                                    value={newWspInput}
                                    onChange={e => setNewWspInput(e.target.value)}
                                    inputMode="numeric"
                                />
                                <p className="text-xs text-slate-500 mt-1">
                                    {pendingUser.whatsapp
                                        ? `Actual: ${pendingUser.whatsapp}. Déjalo igual o escribe uno nuevo.`
                                        : "No tienes WhatsApp registrado. Agrégalo aquí (opcional pero recomendado)."}
                                </p>
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <button
                                className="flex-1 rounded-2xl p-3 font-bold text-sm transition-all disabled:opacity-50"
                                style={{
                                    background: modalLoading
                                        ? "rgba(99,102,241,0.6)"
                                        : "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)",
                                    color: "white",
                                    boxShadow: modalLoading ? "none" : "0 4px 15px rgba(99,102,241,0.4)",
                                }}
                                onClick={handleChangePassword}
                                disabled={modalLoading}
                            >
                                {modalLoading ? (
                                    <span className="flex items-center justify-center gap-2">
                                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                                        </svg>
                                        Guardando...
                                    </span>
                                ) : "Guardar y entrar"}
                            </button>
                            <button
                                className="px-4 py-3 rounded-2xl border font-semibold text-slate-400 text-sm border-slate-600 hover:border-slate-400 transition-colors"
                                onClick={() => { setModalMode(null); setPendingUser(null); setModalError(""); setNewPass(""); setConfirmPass(""); setNewWspInput(""); }}
                                disabled={modalLoading}
                            >
                                Cancelar
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
}
