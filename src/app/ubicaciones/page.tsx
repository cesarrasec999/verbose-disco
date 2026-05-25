"use client";

import DashboardPage from "@/app/dashboard/page";

export default function UbicacionesPage() {
  if (typeof window !== "undefined") {
    sessionStorage.setItem("cyclic_active_tab", "ubicaciones");
  }

  return <DashboardPage />;
}
