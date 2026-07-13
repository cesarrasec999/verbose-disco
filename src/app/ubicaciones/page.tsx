"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function UbicacionesPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="ubicaciones" />
    </Suspense>
  );
}
