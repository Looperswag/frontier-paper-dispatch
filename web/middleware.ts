import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 三态门：
// 1) NEXT_PUBLIC_DEMO_MODE=1 → 公开只读 demo：放行 GET/HEAD，拦截一切写（含 /api/* 的 POST/DELETE）。
// 2) 否则若设了 APP_PASSWORD → 全站 Basic Auth 口令门（Vercel 免费版替代官方保护）。
// 3) 都没设（本地开发）→ 全放行。
export function middleware(req: NextRequest) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1") {
    if (req.method === "GET" || req.method === "HEAD") return NextResponse.next();
    return new NextResponse("只读 demo：写操作已禁用 / read-only demo", { status: 403 });
  }

  const pw = process.env.APP_PASSWORD;
  if (!pw) return NextResponse.next();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (pass === pw) return NextResponse.next();
    } catch {
      /* fallthrough */
    }
  }
  return new NextResponse("需要口令 / Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="frontier-papers"' },
  });
}

export const config = {
  // 覆盖除静态资源外的所有路由（含 /api/*）
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
