import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 简单口令门（HTTP Basic Auth）。仅当设置了 APP_PASSWORD 才启用：
// 本地开发（未设）不受影响；线上（在 Vercel 设了）则全站含所有 API 需口令。
// 这是免费方案下替代 Vercel Deployment Protection 的方案；正式登录见 Phase 5。
export function middleware(req: NextRequest) {
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
  // 保护除静态资源外的所有路由（含 /api/*）
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
