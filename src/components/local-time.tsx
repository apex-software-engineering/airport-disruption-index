'use client';
/**
 * The viewer's local time beside a UTC time the server rendered. The time zone is the browser's,
 * so the server and the hydrating render use the UTC-only snapshot and the client adds the local
 * time straight after hydration. With scripting off it is never shown: the UTC time stands alone.
 */
import { useSyncExternalStore } from 'react';

import { formatLocal, formatLocalHour, formatLocalRange, isUtcOffsetZero } from './format';

/** The time zone is read once per page view; a change of OS zone shows after a reload. */
const subscribe = () => () => {};
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noTimeZone = () => null;

function useViewerTimeZone(): string | null {
	return useSyncExternalStore(subscribe, browserTimeZone, noTimeZone);
}

type Span = {
	/** An ISO instant. */
	at: string;
	/** With an end instant, the span `at`..`until`, such as a UTC day. */
	until?: string;
};

function localText({ at, until }: Span, timeZone: string): string {
	return `(${until === undefined ? formatLocal(at, timeZone) : formatLocalRange(at, until, timeZone)})`;
}

/**
 * An SVG `<title>` tooltip: `before`, the local time once known, then `after`, as one string,
 * since React renders a `<title>` child only as text. The server and a page without scripting
 * show `before` + `after`, all UTC.
 */
export function LocalTimeTitle({
	at,
	before,
	after,
}: {
	at: string;
	before: string;
	after: string;
}) {
	const timeZone = useViewerTimeZone();
	const local = timeZone === null ? '' : ` ${localText({ at }, timeZone)}`;
	return <title>{`${before}${local}${after}`}</title>;
}

/** The compact local clock time for a chart axis, e.g. `6 PM`; empty until known. */
export function LocalHour({ at }: { at: string }) {
	const timeZone = useViewerTimeZone();
	return timeZone === null ? '' : formatLocalHour(at, timeZone);
}

/**
 * The local time in parentheses. Its slot is reserved from the first paint by the same text in
 * UTC, laid invisibly in the same grid cell, so the local time fills it instead of pushing the
 * text around it. `line` puts it on a line of its own, for headings and table cells.
 */
export function LocalTime({ at, until, line = false }: Span & { line?: boolean }) {
	const timeZone = useViewerTimeZone();
	const span = { at, until };
	const repeatsUtc =
		timeZone !== null &&
		isUtcOffsetZero(at, timeZone) &&
		(until === undefined || isUtcOffsetZero(until, timeZone));
	return (
		<span
			className={
				line ? 'noscript:hidden text-ink-muted block text-sm font-normal' : 'noscript:hidden'
			}>
			{' '}
			<span className={line ? 'grid' : 'inline-grid whitespace-nowrap'}>
				<span aria-hidden className='invisible [grid-area:1/1]'>
					{localText(span, 'UTC')}
				</span>
				<span data-local-time aria-hidden={repeatsUtc} className='[grid-area:1/1]'>
					{timeZone === null ? null : localText(span, timeZone)}
				</span>
			</span>
		</span>
	);
}
