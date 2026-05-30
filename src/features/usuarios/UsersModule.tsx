"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { CyclicUser, Role, Store } from "@/features/ciclicos/types";
import {
  MODULE_ACCESS_OPTIONS,
  legacyModuleAccessForRole,
  moduleLabel,
  normalizedModuleAccess,
  type ModuleAccessKey,
} from "@/features/access/moduleAccess";

type Props = {
  stores: Store[];
  showMessage: (text: string, type?: "info" | "success" | "error") => void;
};

export function UsersModule({ stores, showMessage }: Props) {
  const [users, setUsers] = useState<CyclicUser[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newRole, setNewRole] = useState<Role>("Operario");
  const [newUserStoreId, setNewUserStoreId] = useState("");
  const [newUserAllStores, setNewUserAllStores] = useState(false);
  const [newUserWhatsapp, setNewUserWhatsapp] = useState("");
  const [newUserAuditAccess, setNewUserAuditAccess] = useState(false);
  const [newUserModuleAccess, setNewUserModuleAccess] = useState<ModuleAccessKey[]>(["cyclic_count_take"]);
  const [editingUser, setEditingUser] = useState<CyclicUser | null>(null);
  const [editUserFullName, setEditUserFullName] = useState("");
  const [editUserRole, setEditUserRole] = useState<Role>("Operario");
  const [editUserWhatsapp, setEditUserWhatsapp] = useState("");
  const [editUserStoreId, setEditUserStoreId] = useState("");
  const [editUserAllStores, setEditUserAllStores] = useState(false);
  const [editUserActive, setEditUserActive] = useState(true);
  const [editUserPassword, setEditUserPassword] = useState("");
  const [editUserAuditAccess, setEditUserAuditAccess] = useState(false);
  const [editUserModuleAccess, setEditUserModuleAccess] = useState<ModuleAccessKey[]>(["cyclic_count_take"]);

  async function loadUsers() {
    const { data } = await supabase.from("cyclic_users").select("id, username, full_name, role, store_id, can_access_all_stores, can_access_audit, module_access, is_active, whatsapp").order("full_name");
    setUsers((data || []) as CyclicUser[]);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsers(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && editingUser) setEditingUser(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingUser]);

  async function createUser() {
    if (!newUsername.trim() || !newPassword.trim() || !newFullName.trim()) {
      showMessage("Usuario, contraseña y nombre son obligatorios.", "error");
      return;
    }
    if (newUserModuleAccess.length === 0) {
      showMessage("Selecciona al menos un modulo.", "error");
      return;
    }

    const { data: existing } = await supabase.from("cyclic_users").select("id").eq("username", newUsername.trim().toLowerCase()).maybeSingle();
    if (existing) {
      showMessage("Nombre de usuario ya existe.", "error");
      return;
    }

    const wsp = newUserWhatsapp.trim().replace(/\D/g, "");
    const moduleAccess = [...new Set(newUserModuleAccess)];
    const { error } = await supabase.from("cyclic_users").insert({
      username: newUsername.trim().toLowerCase(),
      password: newPassword.trim(),
      full_name: newFullName.trim(),
      role: newRole,
      store_id: newUserAllStores ? null : (newUserStoreId || null),
      can_access_all_stores: newUserAllStores,
      can_access_audit: moduleAccess.includes("audit") || newRole === "Administrador" || newRole === "Supervisor" ? true : newUserAuditAccess,
      module_access: moduleAccess,
      is_active: true,
      whatsapp: wsp || null,
    });
    if (error) {
      showMessage("Error: " + error.message, "error");
      return;
    }

    showMessage("✅ Usuario creado.", "success");
    setNewUsername("");
    setNewPassword("");
    setNewFullName("");
    setNewRole("Operario");
    setNewUserStoreId("");
    setNewUserWhatsapp("");
    setNewUserAuditAccess(false);
    setNewUserModuleAccess(["cyclic_count_take"]);
    await loadUsers();
  }

  function openEditUser(user: CyclicUser) {
    setEditingUser(user);
    setEditUserFullName(user.full_name || "");
    setEditUserRole(user.role);
    setEditUserStoreId(user.store_id || "");
    setEditUserAllStores(user.can_access_all_stores);
    setEditUserActive(user.is_active);
    setEditUserPassword("");
    setEditUserWhatsapp(user.whatsapp || "");
    setEditUserAuditAccess(user.role === "Administrador" || user.role === "Supervisor" ? true : !!user.can_access_audit);
    setEditUserModuleAccess(normalizedModuleAccess(user));
  }

  function toggleNewUserModuleAccess(key: ModuleAccessKey, checked: boolean) {
    setNewUserModuleAccess((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      if (key === "audit") setNewUserAuditAccess(checked);
      return [...next];
    });
  }

  function toggleEditUserModuleAccess(key: ModuleAccessKey, checked: boolean) {
    setEditUserModuleAccess((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      if (key === "audit") setEditUserAuditAccess(checked);
      return [...next];
    });
  }

  async function saveEditUser() {
    if (!editingUser) return;
    if (!editUserFullName.trim()) {
      showMessage("El nombre completo es obligatorio.", "error");
      return;
    }
    if (editUserModuleAccess.length === 0) {
      showMessage("Selecciona al menos un modulo.", "error");
      return;
    }

    const wsp = editUserWhatsapp.trim().replace(/\D/g, "");
    const moduleAccess = [...new Set(editUserModuleAccess)];
    const updates: Record<string, unknown> = {
      full_name: editUserFullName.trim(),
      role: editUserRole,
      store_id: editUserAllStores ? null : (editUserStoreId || null),
      can_access_all_stores: editUserAllStores,
      can_access_audit: moduleAccess.includes("audit") || editUserRole === "Administrador" || editUserRole === "Supervisor" ? true : editUserAuditAccess,
      module_access: moduleAccess,
      is_active: editUserActive,
      whatsapp: wsp || null,
    };
    if (editUserPassword.trim()) updates.password = editUserPassword.trim();

    const { error } = await supabase.from("cyclic_users").update(updates).eq("id", editingUser.id);
    if (error) {
      showMessage("Error: " + error.message, "error");
      return;
    }

    showMessage("✅ Usuario actualizado.", "success");
    setEditingUser(null);
    await loadUsers();
  }

  async function deleteUser(user: CyclicUser) {
    if (!confirm(`¿Eliminar usuario "${user.username}"? Esta acción no se puede deshacer.`)) return;
    const { error } = await supabase.from("cyclic_users").delete().eq("id", user.id);
    if (error) {
      showMessage("Error: " + error.message, "error");
      return;
    }
    showMessage("✅ Usuario eliminado.", "success");
    await loadUsers();
  }

  return (
    <>
      <section className="bg-white rounded-3xl p-5 shadow space-y-4">
        <h2 className="text-xl font-bold text-slate-900">Usuarios</h2>
        <div className="rounded-2xl bg-slate-50 border p-4 space-y-3">
          <p className="text-sm font-semibold text-slate-700">Crear nuevo usuario</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900" placeholder="Nombre de usuario" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
            <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900" placeholder="Contraseña" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900 md:col-span-2" placeholder="Nombre completo" value={newFullName} onChange={(e) => setNewFullName(e.target.value)} />
            <input className="border rounded-2xl p-3 text-sm bg-white text-slate-900 md:col-span-2" placeholder="WhatsApp (ej: 51987654321 - con codigo de pais)" value={newUserWhatsapp} onChange={(e) => setNewUserWhatsapp(e.target.value)} />
            <div>
              <label className="text-xs text-slate-500 block mb-1">Rol</label>
              <select className="w-full border rounded-2xl p-3 text-sm bg-white text-slate-900" value={newRole} onChange={(e) => { const role = e.target.value as Role; setNewRole(role); setNewUserModuleAccess(legacyModuleAccessForRole(role, newUserAuditAccess)); if (role !== "Operario") setNewUserAllStores(true); }}>
                <option value="Operario">Operario</option>
                <option value="Validador">Validador</option>
                <option value="Supervisor">Supervisor lectura</option>
                <option value="Administrador">Administrador</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Tienda asignada</label>
              <select className="w-full border rounded-2xl p-3 text-sm bg-white text-slate-900" value={newUserStoreId} onChange={(e) => setNewUserStoreId(e.target.value)} disabled={newUserAllStores}>
                <option value="">- Sin asignar -</option>
                {stores.filter((store) => store.is_active).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-3 rounded-2xl border bg-white p-3 text-sm font-semibold text-slate-700">
              <input type="checkbox" checked={newUserAllStores} onChange={(e) => setNewUserAllStores(e.target.checked)} />
              Puede ver todas las tiendas
            </label>
            <div className="rounded-2xl border bg-white p-3 md:col-span-2">
              <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Modulos permitidos</p>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {MODULE_ACCESS_OPTIONS.map((option) => (
                  <label key={option.key} className="flex items-center gap-2 rounded-xl border bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
                    <input type="checkbox" checked={newUserModuleAccess.includes(option.key)} onChange={(e) => toggleNewUserModuleAccess(option.key, e.target.checked)} />
                    {option.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <button className="px-5 py-3 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={createUser}>+ Crear usuario</button>
        </div>

        <div className="border rounded-2xl overflow-hidden">
          <div className="max-h-[450px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 sticky top-0">
                <tr>
                  <th className="p-2 border text-left">Usuario</th>
                  <th className="p-2 border text-left">Nombre</th>
                  <th className="p-2 border">Rol</th>
                  <th className="p-2 border">Tienda</th>
                  <th className="p-2 border">WhatsApp</th>
                  <th className="p-2 border">Modulos</th>
                  <th className="p-2 border">Estado</th>
                  <th className="p-2 border">Accion</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => {
                  const store = stores.find((item) => item.id === user.store_id);
                  return (
                    <tr key={user.id} className={!user.is_active ? "opacity-40" : ""}>
                      <td className="p-2 border font-mono text-xs">{user.username}</td>
                      <td className="p-2 border font-medium">{user.full_name}</td>
                      <td className="p-2 border text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${user.role === "Administrador" ? "bg-purple-100 text-purple-700" : user.role === "Supervisor" ? "bg-emerald-100 text-emerald-700" : user.role === "Validador" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-700"}`}>{user.role}</span>
                      </td>
                      <td className="p-2 border text-center text-xs">{user.can_access_all_stores ? "Todas" : (store?.name || "-")}</td>
                      <td className="p-2 border text-center text-xs">
                        {user.whatsapp
                          ? <a href={`https://wa.me/${user.whatsapp}`} target="_blank" rel="noreferrer" className="text-green-600 font-semibold hover:underline">{user.whatsapp}</a>
                          : <span className="text-slate-400">-</span>}
                      </td>
                      <td className="p-2 border text-center">
                        <div className="flex max-w-xs flex-wrap justify-center gap-1">
                          {normalizedModuleAccess(user).map((key) => (
                            <span key={key} className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black text-slate-600">
                              {moduleLabel(key)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-2 border text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${user.is_active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{user.is_active ? "Activo" : "Inactivo"}</span>
                      </td>
                      <td className="p-2 border text-center">
                        <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold mr-1" onClick={() => openEditUser(user)}>Editar</button>
                        <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold text-red-600 border-red-200" onClick={() => void deleteUser(user)}>x</button>
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-400">No hay usuarios.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {editingUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
          <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-md space-y-4 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Editar usuario</h3>
                <p className="text-slate-600 text-sm">{editingUser.username} - {editingUser.full_name}</p>
              </div>
              <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setEditingUser(null)}>x</button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-semibold mb-1 text-slate-900">Nombre completo</label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editUserFullName} onChange={(e) => setEditUserFullName(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1 text-slate-900">Rol</label>
                <select className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editUserRole} onChange={(e) => { const role = e.target.value as Role; setEditUserRole(role); setEditUserModuleAccess(legacyModuleAccessForRole(role, editUserAuditAccess)); if (role !== "Operario") setEditUserAllStores(true); }}>
                  <option value="Operario">Operario</option>
                  <option value="Validador">Validador</option>
                  <option value="Supervisor">Supervisor lectura</option>
                  <option value="Administrador">Administrador</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1 text-slate-900">Tienda asignada</label>
                <select className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editUserStoreId} onChange={(e) => setEditUserStoreId(e.target.value)} disabled={editUserAllStores}>
                  <option value="">- Sin asignar -</option>
                  {stores.filter((store) => store.is_active).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
                </select>
              </div>
              <label className="flex items-center gap-3 rounded-2xl border bg-white p-3 text-sm font-semibold text-slate-700">
                <input type="checkbox" checked={editUserAllStores} onChange={(e) => setEditUserAllStores(e.target.checked)} />
                Puede ver todas las tiendas
              </label>
              <div>
                <label className="block text-sm font-semibold mb-1 text-slate-900">Nueva contraseña <span className="text-slate-400 font-normal">(dejar vacio para no cambiar)</span></label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" placeholder="Nueva contraseña..." value={editUserPassword} onChange={(e) => setEditUserPassword(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1 text-slate-900">WhatsApp <span className="text-slate-400 font-normal">(con codigo de pais, ej: 51987654321)</span></label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" placeholder="51987654321" value={editUserWhatsapp} onChange={(e) => setEditUserWhatsapp(e.target.value)} />
              </div>
              <div className="rounded-2xl border bg-white p-3">
                <p className="mb-2 text-xs font-black uppercase tracking-wide text-slate-500">Modulos permitidos</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {MODULE_ACCESS_OPTIONS.map((option) => (
                    <label key={option.key} className="flex items-center gap-2 rounded-xl border bg-slate-50 px-3 py-2 text-xs font-bold text-slate-700">
                      <input type="checkbox" checked={editUserModuleAccess.includes(option.key)} onChange={(e) => toggleEditUserModuleAccess(option.key, e.target.checked)} />
                      {option.label}
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1 text-slate-900">Estado</label>
                <div className="flex gap-3">
                  <button className={`flex-1 py-2.5 rounded-xl font-semibold text-sm border ${editUserActive ? "bg-green-600 text-white border-green-600" : "bg-white text-slate-700 border-slate-300"}`} onClick={() => setEditUserActive(true)}>Activo</button>
                  <button className={`flex-1 py-2.5 rounded-xl font-semibold text-sm border ${!editUserActive ? "bg-red-500 text-white border-red-500" : "bg-white text-slate-700 border-slate-300"}`} onClick={() => setEditUserActive(false)}>Inactivo</button>
                </div>
              </div>
            </div>
            <div className="flex gap-3 pt-1">
              <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditUser}>Guardar cambios</button>
              <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700" onClick={() => setEditingUser(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
