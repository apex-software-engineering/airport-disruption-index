import { METHODOLOGY, PARAMETER_HASH } from '@/lib/index/methodology';
import { CACHE, json } from '@/server/http';

export function GET() {
	return json(
		{
			version: METHODOLOGY.version,
			parameterHash: PARAMETER_HASH,
			parameterHashAlgorithm:
				'sha256 of the canonical JSON (sorted keys, no whitespace) of parameters',
			parameters: METHODOLOGY,
		},
		CACHE.daily,
	);
}
