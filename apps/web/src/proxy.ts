import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_SESSION_COOKIE } from '@scenox/shared';

/** Directory-style prefixes (match `/x` and `/x/...`) and file-style prefixes (match `/x*`). */
const PUBLIC_DIRS = ['/login', '/setup', '/u', '/_next', '/api'];
const PUBLIC_FILES = ['/favicon', '/robots.txt', '/icon', '/apple-icon'];
const UPLOAD_HOST_DIRS = ['/u', '/_next', '/api'];

const matches = (path: string, dirs: string[], files: string[] = PUBLIC_FILES) =>
  dirs.some((d) => path === d || path.startsWith(`${d}/`)) || files.some((f) => path.startsWith(f));

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const uploadHost = process.env.UPLOAD_HOST?.toLowerCase();
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0]!.trim().toLowerCase();

  // Keep the admin UI off the client-facing upload domain.
  if (uploadHost && (host === uploadHost || host.split(':')[0] === uploadHost)) {
    if (!matches(pathname, UPLOAD_HOST_DIRS)) {
      return new NextResponse('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return NextResponse.next();
  }

  // Cheap pre-check; real authorization happens server-side.
  if (pathname !== '/' && !matches(pathname, PUBLIC_DIRS) && !request.cookies.has(ADMIN_SESSION_COOKIE)) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
