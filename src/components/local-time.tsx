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
 * The local time in parentheses, on a line of its own under the UTC text. The line is reserved
 * from the first paint at a fixed one-line height, never wraps (a form too long for it ends in
 * an ellipsis, in full in its tooltip) and adds nothing to its container's width, so filling it
 * in after hydration cannot move anything else on the page.
 */
export function LocalTime({ at, until }: Span) {
	const timeZone = useViewerTimeZone();
	const text = timeZone === null ? undefined : localText({ at, until }, timeZone);
	const repeatsUtc =
		timeZone !== null &&
		isUtcOffsetZero(at, timeZone) &&
		(until === undefined || isUtcOffsetZero(until, timeZone));
	return (
		<span
			data-local-time
			title={text}
			aria-hidden={repeatsUtc}
			className='noscript:hidden text-ink-muted block h-[1lh] overflow-hidden text-xs font-normal text-ellipsis whitespace-nowrap contain-inline-size'>
			{text}
		</span>
	);
}
