/**
 * Display formatting for the public pages. Every time is shown in UTC, the canonical value; the
 * viewer's local time is added beside it in the browser, from `formatLocal`/`formatLocalRange`.
 */

const INTEGER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

export function formatInteger(value: number): string {
	return INTEGER.format(value);
}

/** `percent` is already in percent units (0..100), as the API publishes it. */
export function formatPercent(percent: number): string {
	return `${PERCENT.format(percent)}%`;
}

function instant(iso: string): Date {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${iso}`);
	return date;
}

/** `2026-11-19T14:05:31.000Z` → `2026-11-19 14:05:31 UTC`. */
export function formatUtc(iso: string): string {
	return `${instant(iso).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `2026-11-19T14:00:00.000Z` → `14:00`. */
export function formatUtcHour(iso: string): string {
	return instant(iso).toISOString().slice(11, 16);
}

const LOCAL_OPTIONS = {
	// Always with the date, since the local day often differs from the UTC day.
	full: {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short',
	},
	noZone: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
	hour: { hour: 'numeric', minute: '2-digit' },
	wallClock: {
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		hourCycle: 'h23',
	},
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

const localFormats = new Map<string, Intl.DateTimeFormat>();

/** Building a formatter is costly and a page formats many times in one zone. */
function localFormat(timeZone: string, kind: keyof typeof LOCAL_OPTIONS): Intl.DateTimeFormat {
	const key = `${kind} ${timeZone}`;
	let format = localFormats.get(key);
	if (format === undefined) {
		format = new Intl.DateTimeFormat('en-US', { timeZone, ...LOCAL_OPTIONS[kind] });
		localFormats.set(key, format);
	}
	return format;
}

/** `2026-11-22T00:30:00Z` in America/New_York → `Nov 21, 7:30 PM EST`. */
export function formatLocal(iso: string, timeZone: string): string {
	return localFormat(timeZone, 'full').format(instant(iso));
}

function zoneName(at: Date, timeZone: string): string | undefined {
	return localFormat(timeZone, 'full')
		.formatToParts(at)
		.find((part) => part.type === 'timeZoneName')?.value;
}

/**
 * `Nov 20, 6:00 PM – Nov 21, 6:00 PM CST`. The zone is written once when both ends share it,
 * and at each end when they differ (a DST change), even when both fall on the same local date.
 */
export function formatLocalRange(startIso: string, endIso: string, timeZone: string): string {
	const start = instant(startIso);
	const end = instant(endIso);
	const startText =
		zoneName(start, timeZone) === zoneName(end, timeZone)
			? localFormat(timeZone, 'noZone').format(start)
			: localFormat(timeZone, 'full').format(start);
	return `${startText} – ${localFormat(timeZone, 'full').format(end)}`;
}

/** A compact clock time for chart axes: `6 PM`, or `5:30 AM` off the hour. */
export function formatLocalHour(iso: string, timeZone: string): string {
	return localFormat(timeZone, 'hour').format(instant(iso)).replace(':00', '');
}

/** Whether local time in `timeZone` equals UTC at that instant, so a local time repeats it. */
export function isUtcOffsetZero(iso: string, timeZone: string): boolean {
	const at = instant(iso);
	const parts = localFormat(timeZone, 'wallClock').formatToParts(at);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value);
	const wallClockAsUtc = Date.UTC(
		part('year'),
		part('month') - 1,
		part('day'),
		part('hour'),
		part('minute'),
	);
	return wallClockAsUtc === Math.floor(at.getTime() / 60_000) * 60_000;
}
