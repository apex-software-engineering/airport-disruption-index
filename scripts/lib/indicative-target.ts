import type { StoreTarget } from '@/server/storage';

/**
 * Whether `npm run indicative` may write to `target`. Before the indicative series is published
 * (`indicativeSeriesPublished`), nothing is frozen into the production namespace; preview and
 * filesystem stores stay open for rehearsal.
 */
export function indicativeWriteRefusal(target: StoreTarget, published: boolean): string | null {
	const production = target.kind === 'blob' && target.namespace === 'prod';
	if (published || !production) return null;
	return 'the indicative series is not yet published, so nothing is frozen into production; rehearse with VERCEL_ENV=preview';
}
