/** Response helpers shared by the API route handlers. */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Cache policies. Receipts of ended slots and their raw bodies never change. */
export const CACHE = {
	immutable: 'public, max-age=31536000, immutable',
	live: 'public, max-age=0, s-maxage=60, stale-while-revalidate=240',
	daily: 'public, max-age=300, s-maxage=3600',
	none: 'no-store',
} as const;

const PUBLIC_HEADERS = { 'Access-Control-Allow-Origin': '*' };

export function json(data: unknown, cache: string, status = 200): Response {
	return Response.json(data, { status, headers: { ...PUBLIC_HEADERS, 'Cache-Control': cache } });
}

/**
 * Third-party bytes served from our origin. Sandboxed and never sniffed, so an upstream body
 * that happens to be HTML or script-bearing XML cannot run in a viewer's browser.
 */
export function untrustedBytes(body: Uint8Array, contentType: string, cache: string): Response {
	return new Response(Buffer.from(body), {
		headers: {
			...PUBLIC_HEADERS,
			'Content-Type': contentType,
			'Cache-Control': cache,
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox",
		},
	});
}

export function problem(status: number, error: string): Response {
	return json({ error }, status >= 500 ? CACHE.none : 'public, max-age=60', status);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. No secret configured means no access. */
export function cronAuthorized(
	request: Request,
	secret: string | undefined = process.env.CRON_SECRET,
): boolean {
	if (!secret) return false;
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return timingSafeEqual(
		digest(request.headers.get('authorization') ?? ''),
		digest(`Bearer ${secret}`),
	);
}
