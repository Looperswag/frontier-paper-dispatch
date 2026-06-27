import type { NextConfig } from "next";

// 仓库里有两个 lockfile（根的 ingest 脚本 + web/），显式指定 web/ 为 Turbopack root，消除推断告警。
const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
};

export default nextConfig;
