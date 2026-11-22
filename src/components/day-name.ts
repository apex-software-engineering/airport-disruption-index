import type { DayTimeZone, MethodologyParameters } from '@/lib/index/methodology';

/** How the site names a release's settlement day: "UTC day" or "America/New_York day". */
export function dayName(parameters: MethodologyParameters): string {
	return parameters.day === 'utc' ? 'UTC day' : `${parameters.day.timeZone} day`;
}

/** The short label a day carries beside its date, e.g. "2026-11-20 (ET)" or "(UTC)". */
export const ZONE_LABEL: Record<'UTC' | DayTimeZone, string> = {
	UTC: 'UTC',
	'America/New_York': 'ET',
};
