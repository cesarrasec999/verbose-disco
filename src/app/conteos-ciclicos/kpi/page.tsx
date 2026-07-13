"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosKpiPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="dashboard" />
    </Suspense>
  );
}
