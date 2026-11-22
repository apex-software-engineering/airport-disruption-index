/**
 * Whether `npm run indicative` may write to the store an environment names. Before the indicative
 * series is published (`indicativeSeriesPublished`), nothing is frozen into production; the
 * preview namespace and a filesystem store stay open for rehearsal.
 */
export function indicativeWriteRefusal(
	env: Readonly<Record<string, string | undefined>>,
	published: boolean,
): string | null {
	// The filesystem store wins over VERCEL_ENV (storage.storeFromEnv), so it is never production.
	const production = !env.ADI_DATA_DIR && env.VERCEL_ENV === 'production';
	if (published || !production) return null;
	return 'the indicative series is not yet published, so nothing is frozen into production; rehearse with VERCEL_ENV=preview';
}
