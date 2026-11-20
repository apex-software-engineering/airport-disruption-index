/** Display formatting for the public pages. Every time shown on the site is UTC. */

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

/** `2026-11-19T14:05:31.000Z` → `2026-11-19 14:05:31 UTC`. */
export function formatUtc(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${iso}`);
	return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** `2026-11-19T14:00:00.000Z` → `14:00`. */
export function formatUtcHour(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) throw new Error(`not an instant: ${iso}`);
	return date.toISOString().slice(11, 16);
}
