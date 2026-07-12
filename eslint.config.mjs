import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Las reglas de React Compiler que trae por defecto eslint-config-next
    // 16.x son mas estrictas que el codigo existente en varios modulos
    // (bootstrap de usuario desde localStorage en un efecto para evitar
    // mismatch de hidratacion, banners de "sincronizacion desactualizada"
    // con Date.now(), memoizacion manual en archivos grandes anteriores al
    // Compiler). Downgradeadas a warning para no bloquear el build/CI
    // mientras se migran esos modulos; no se desactivan del todo para que
    // sigan siendo visibles como deuda tecnica.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
