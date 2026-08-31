import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/admin/optimizar-reporte-rotaciones": [
      "./supabase/migrations/20260831175705_align_rotation_average_thresholds.sql",
    ],
  },
};

export default nextConfig;
