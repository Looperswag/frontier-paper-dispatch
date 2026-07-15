import type { NextConfig } from "next";
import path from "node:path";

const projectRoot = path.resolve(__dirname);

// 把服务端 CJS 依赖标记为 external，避免被打进 bundle 后在某些运行时丢失 __dirname（ReferenceError）。
const nextConfig: NextConfig = {
  outputFileTracingRoot: projectRoot,
  serverExternalPackages: ["@supabase/supabase-js", "sanitize-html", "docx", "marked", "openai"],
  turbopack: { root: projectRoot },
};

export default nextConfig;
