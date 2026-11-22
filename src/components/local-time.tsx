'use client';
/**
 * The viewer's local time beside a UTC time the server rendered. The time zone is the browser's,
 * so the client fills it in straight after hydration. Until then the same text in UTC holds its
 * place invisibly, so the page does not move when it appears, and both renders agree. With
 * scripting off it is not rendered at all: the UTC time stands alone.
 */
import { useSyncExternalStore } from 'react';

import { formatLocal, formatLocalRange } from './format';

/** The time zone never changes during a page view. */
const subscribe = () => () => {};
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noTimeZone = () => null;

function useViewerTimeZone(): string | null {
	return useSyncExternalStore(subscribe, browserTimeZone, noTimeZone);
}

type LocalTimeProps = {
	/** An ISO instant. */
	at: string;
	/** With an end instant, the span `at`..`until`, such as a UTC day. */
	until?: string;
};

function localText({ at, until }: LocalTimeProps, timeZone: string): string {
	const local =
		until === undefined ? formatLocal(at, timeZone) : formatLocalRange(at, until, timeZone);
	return `(${local})`;
}

/** Bare text, for places that take text only, such as an SVG `<title>` tooltip. */
export function LocalTimeText(props: LocalTimeProps) {
	const timeZone = useViewerTimeZone();
	return timeZone === null ? null : localText(props, timeZone);
}

export function LocalTime(props: LocalTimeProps) {
	const timeZone = useViewerTimeZone();
	const placeholder = timeZone === null;
	return (
		<span
			data-local-time
			aria-hidden={placeholder}
			className={`noscript:hidden ${placeholder ? 'invisible' : ''}`}>
			{` ${localText(props, timeZone ?? 'UTC')}`}
		</span>
	);
}
