import type { DayTimeZone, MethodologyParameters } from '@/lib/index/methodology';

/** How the site names a release's settlement day: "UTC day" or "America/New_York day". */
export function dayName(parameters: MethodologyParameters): string {
	return parameters.day === 'utc' ? 'UTC day' : `${parameters.day.timeZone} day`;
}

/** The short label a zoned day carries beside its date, e.g. "2026-11-20 (ET)". */
export const ZONE_LABEL: Record<DayTimeZone, string> = { 'America/New_York': 'ET' };
