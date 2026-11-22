import type { MethodologyParameters } from '@/lib/index/methodology';

/** How the site names a release's settlement day: "UTC day" or "America/New_York day". */
export function dayName(parameters: MethodologyParameters): string {
	return parameters.day === 'utc' ? 'UTC day' : `${parameters.day.timeZone} day`;
}
