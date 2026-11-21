import { methodologyFor } from '@/lib/index/methodology';
import { utcDateOf } from '@/lib/index/time';
import { CACHE, json } from '@/server/http';

/** The methodology in effect today. */
export function GET() {
	const { parameters, parameterHash } = methodologyFor(utcDateOf(new Date()));
	return json(
		{
			version: parameters.version,
			parameterHash,
			parameterHashAlgorithm:
				'sha256 of the canonical JSON (sorted keys, no whitespace) of parameters',
			parameters,
		},
		CACHE.daily,
	);
}
