import { GET as getDay } from '@/app/api/v1/days/[date]/route';
import { GET as getRaw } from '@/app/api/v1/rounds/[id]/raw/route';
import { GET as getRound } from '@/app/api/v1/rounds/[id]/route';
import type { Get } from '@/lib/reproduce';

/** Serves the public API from the route handlers over the store `ADI_DATA_DIR` names. */
export const routeGet: Get = async (url) => {
	const { pathname } = new URL(url);
	const request = new Request(url);
	const day = /^\/api\/v1\/days\/([^/]+)$/.exec(pathname);
	if (day?.[1] !== undefined) return getDay(request, { params: Promise.resolve({ date: day[1] }) });
	const raw = /^\/api\/v1\/rounds\/([^/]+)\/raw$/.exec(pathname);
	if (raw?.[1] !== undefined) return getRaw(request, { params: Promise.resolve({ id: raw[1] }) });
	const round = /^\/api\/v1\/rounds\/([^/]+)$/.exec(pathname);
	if (round?.[1] !== undefined)
		return getRound(request, { params: Promise.resolve({ id: round[1] }) });
	return new Response('not found', { status: 404 });
};
