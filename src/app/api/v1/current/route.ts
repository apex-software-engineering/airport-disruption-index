import { CACHE, json } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { currentView } from '@/server/views';

export const dynamic = 'force-dynamic';

export async function GET() {
	return json(await currentView(storeFromEnv(), new Date()), CACHE.live);
}
