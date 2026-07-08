import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 일회성 운영/마이그레이션 스크립트 (Next.js 앱 빌드 대상 아님, node/tsx 로 수동 실행)
    "scripts/**",
  ]),
]);

export default eslintConfig;
