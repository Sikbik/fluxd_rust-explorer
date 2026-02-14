import { NextRequest, NextResponse } from "next/server";

const SKIP_PREFIXES = ["/api", "/_next", "/favicon.ico", "/flux-logo.svg", "/fonts"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }

  try {
    const healthUrl = new URL("/api/health", req.nextUrl.origin);
    const res = await fetch(healthUrl, { cache: "no-store" });
    if (res.status === 200) {
      return NextResponse.next();
    }
  } catch {
    // Treat health errors as not ready.
  }

  return new NextResponse("Node syncing. Please retry shortly.", {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|flux-logo.svg|fonts).*)"],
};
