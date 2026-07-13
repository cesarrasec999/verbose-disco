"use client";

import { useEffect } from "react";
import { isMobileAccessViewport } from "@/lib/mobileAccess";

export default function AuditoriaPage() {
  useEffect(() => {
    window.location.replace(isMobileAccessViewport() ? "/auditoria/registro" : "/auditoria/sesiones");
  }, []);
  return null;
}
