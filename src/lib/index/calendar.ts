/**
 * Settlement days in time. The only code that turns a release and a day label into instants
 * (`dayWindow`), or an instant into a settlement day (`dayAt`) or into the release that collects it
 * (`collectingRelease`). Every deadline is a fixed duration from a day's window, so DST never moves
 * one. Slots stay the 5-minute UTC grid of time.ts: a day is a run of whole slots.
 */
import {
	activeReleases,
	governs,
	isActiveIn,
	isNoticePublished,
	SETTLEMENT_CUTOFF_MINUTES,
	settlementReleaseFor,
	settlementReleaseOrNull,
	SLOT_MINUTES,
	type DayLabel,
	type DayTimeZone,
	type Methodology,
} from './methodology';
import { RELEASES } from './releases';
import { addDays, parseUtcDate, utcDateOf, type UtcDate } from './time';

const MINUTE_MS = 60_000;
const SLOT_MS = SLOT_MINUTES * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** One settlement day's instants: `[start, end)`, a whole number of slots and hours. */
export type DayWindow = {
	readonly date: DayLabel;
	readonly start: Date;
	readonly end: Date;
	/** 288 on an ordinary day; 276 or 300 on a DST day in a zoned release. */
	readonly slots: number;
};

/** A day and the release it is computed under, resolved once at an entry point and passed down. */
export type SettlementDay = { readonly release: Methodology; readonly window: DayWindow };

/** The instants of day `label` under `release`'s day boundary, whether or not it governs it. */
export function dayWindow(release: Methodology, label: DayLabel): DayWindow {
	const start = dayStart(release, label);
	// A UTC day is always 24 hours, which also keeps 9999-12-31 (whose next date has no label) valid.
	const end =
		release.parameters.day === 'utc' ? start + DAY_MS : dayStart(release, addDays(label, 1));
	if (start % SLOT_MS !== 0 || (end - start) % HOUR_MS !== 0) {
		throw new Error(`${label} under ${release.parameters.version} is not a whole number of hours`);
	}
	return {
		date: label,
		start: new Date(start),
		end: new Date(end),
		slots: (end - start) / SLOT_MS,
	};
}

/** The settlement day `label`, under the release that owns it. */
export function settlementDay(label: DayLabel): SettlementDay {
	const release = settlementReleaseFor(label);
	return { release, window: dayWindow(release, label) };
}

/** The day label `instant` falls on under `release`'s day boundary. */
export function labelAt(release: Methodology, instant: Date): DayLabel {
	const { day } = release.parameters;
	return day === 'utc' ? utcDateOf(instant) : wallClock(instant.getTime(), day.timeZone).date;
}

export type DayAt =
	| ({ kind: 'day' } & SettlementDay)
	/** After a release's last day and before its successor's first: no settlement day. */
	| { kind: 'transition'; previous: DayWindow; next: DayWindow };

/** The settlement day `instant` falls in, or the transition between two releases' days. */
export function dayAt(instant: Date): DayAt {
	const releases = activeReleases();
	for (const release of releases) {
		const label = labelAt(release, instant);
		if (governs(release, label)) return { kind: 'day', release, window: dayWindow(release, label) };
	}
	for (const cutover of activatedCutovers(releases)) {
		const { previous, next } = cutover;
		if (instant >= previous.end && instant < next.start)
			return { kind: 'transition', previous, next };
	}
	throw new Error(`no methodology is in effect at ${instant.toISOString()}`);
}

/**
 * An activated cutover: a release with an `effectiveUntil` and the active successor that takes
 * over. Its transition interval is `[previous.end, next.start)`, which no settlement day covers.
 */
export type Cutover = {
	readonly to: Methodology;
	/** The last day of `from`. */
	readonly previous: DayWindow;
	/** The first day of `to`. */
	readonly next: DayWindow;
};

/** Every activated cutover among `releases` (active ones only), oldest first. */
export function activatedCutovers(releases: readonly Methodology[]): Cutover[] {
	return releases.flatMap((from, index) => {
		const to = releases[index + 1];
		if (to === undefined || from.effectiveUntil === null) return [];
		return [
			{
				to,
				previous: dayWindow(from, from.effectiveUntil),
				next: dayWindow(to, to.effectiveFrom),
			},
		];
	});
}

/**
 * The activated cutover into `release`, or null while it is not activated: `release` is active
 * (announced, not withdrawn) and the active release before it has its `effectiveUntil` set.
 */
export function activatedCutoverInto(
	release: Methodology,
	releases: readonly Methodology[] = RELEASES,
): Cutover | null {
	return (
		activatedCutovers(releases.filter(isActiveIn(releases))).find((c) => c.to === release) ?? null
	);
}

/**
 * When a release takes effect: the start of its first day under the boundary of the release it
 * replaces (settlement rule 4). v1 took effect at 2026-11-17T00:00Z; v2, replacing v1, at 00:00Z
 * of its first date, five hours before its first ET day starts.
 */
export function effectiveAt(
	release: Methodology,
	releases: readonly Methodology[] = RELEASES,
): Date {
	const index = releases.indexOf(release);
	if (index < 0) {
		throw new Error(
			`${release.parameters.version} is not this registry's release object: when it takes effect depends on the release before it`,
		);
	}
	const predecessor = releases[index - 1] ?? release;
	return dayWindow(predecessor, release.effectiveFrom).start;
}

/** v1 settlement rule 4: a new version is announced at least 30 days before it takes effect. */
export const NOTICE_PERIOD_MS = 30 * DAY_MS;

/**
 * The earliest instant a release announced at N, with its readback proof's block time B, may take
 * effect: max(N, B) + 30 × 24 h (design §2). The later of the two needs no check that B ≥ N.
 */
export function noticeBound(noticeAt: Date, proofAt: Date): Date {
	return new Date(Math.max(noticeAt.getTime(), proofAt.getTime()) + NOTICE_PERIOD_MS);
}

/**
 * The release whose notice is published but which is not in effect at `now`: the registered
 * successor of the release collecting then, unless withdrawn. Null outside a notice period.
 */
export function upcomingRelease(now: Date): Methodology | null {
	const next = RELEASES[RELEASES.indexOf(collectingRelease(now)) + 1];
	if (next === undefined || !isNoticePublished(next, now) || next.withdrawn) return null;
	return effectiveAt(next) > now ? next : null;
}

/** The release in effect at `instant`, which every round fetched then is collected under. */
export function collectingRelease(instant: Date): Methodology {
	const release = activeReleases().findLast((r) => effectiveAt(r) <= instant);
	if (release === undefined)
		throw new Error(`no methodology is in effect at ${instant.toISOString()}`);
	return release;
}

/** A span of instants, `[start, end)`. */
export type Interval = { readonly start: Date; readonly end: Date };

/** The UTC storage partitions (`rounds/{date}/`) a window's slots fall in, in order. */
export function partitionsOf(window: Interval): UtcDate[] {
	const last = utcDateOf(new Date(window.end.getTime() - 1));
	const partitions = [utcDateOf(window.start)];
	while (partitions.at(-1) !== last) partitions.push(addDays(partitions.at(-1) ?? last, 1));
	return partitions;
}

/** The index of the slot starting at `slotStart` within `window`, or null outside it. */
export function slotIndexIn(window: DayWindow, slotStart: Date): number | null {
	const offset = slotStart.getTime() - window.start.getTime();
	if (offset < 0 || offset % SLOT_MS !== 0) return null;
	const index = offset / SLOT_MS;
	return index < window.slots ? index : null;
}

export function slotStartIn(window: DayWindow, index: number): Date {
	return new Date(window.start.getTime() + index * SLOT_MS);
}

/** Number of slots of `window` that have fully ended at `asOf` (0..slots). */
export function elapsedSlots(window: DayWindow, asOf: Date): number {
	const elapsed = Math.floor((asOf.getTime() - window.start.getTime()) / SLOT_MS);
	return Math.min(window.slots, Math.max(0, elapsed));
}

/** When the print for a day may be built: the day's end plus the settlement cutoff. */
export function settlesAt(window: DayWindow): Date {
	return new Date(window.end.getTime() + SETTLEMENT_CUTOFF_MINUTES * MINUTE_MS);
}

/**
 * The print for a day is published by this long after the day ends. A publication commitment,
 * not a methodology parameter: it decides when a print appears, never what it says, so it is
 * kept out of the parameter hash.
 */
const PUBLICATION_DEADLINE_MINUTES_AFTER_DAY_END = 90;

/** When the print for a day is due (v1: D+1 01:30Z). A print published later is still the print. */
export function publishBy(window: DayWindow): Date {
	return new Date(window.end.getTime() + PUBLICATION_DEADLINE_MINUTES_AFTER_DAY_END * MINUTE_MS);
}

/** How far back a default settle run looks: two days, so one missed day of runs is recovered. */
export const SETTLE_LOOKBACK_MS = 48 * HOUR_MS;

/**
 * The settlement days whose cutoff passed in (now − SETTLE_LOOKBACK_MS, now], oldest first, UTC-
 * and zone-labelled alike: what a settle run attempts when no date is named. A label no release
 * owns has no cutoff, and the transition interval has no label, so neither is ever listed.
 */
export function dueSettlementDays(now: Date): SettlementDay[] {
	const today = utcDateOf(now);
	// Every label whose cutoff can fall in the lookback: a day ends at most 2 days after its UTC date.
	return [-3, -2, -1].flatMap((offset) => {
		const label = addDays(today, offset);
		const release = settlementReleaseOrNull(label);
		if (release === null) return [];
		const window = dayWindow(release, label);
		const cutoff = settlesAt(window).getTime();
		return cutoff <= now.getTime() && cutoff > now.getTime() - SETTLE_LOOKBACK_MS
			? [{ release, window }]
			: [];
	});
}

/** How long after the settlement cutoff a correction may be issued without an override. */
const CORRECTION_WINDOW_MS = 24 * HOUR_MS;

/**
 * Corrections to a day are issued within 24 hours of its settlement cutoff (v1: D+2 00:30Z), the
 * earliest the original print can have been published, so the window never runs longer than 24
 * hours after it. Computed from the print's own `settlesAt`, so anyone can check a correction.
 */
export function correctionDeadline(settles: Date): Date {
	return new Date(settles.getTime() + CORRECTION_WINDOW_MS);
}

/** The instant 00:00 local starts `label` in `release`'s boundary. */
function dayStart(release: Methodology, label: DayLabel): number {
	const midnightUtc = parseUtcDate(label);
	if (midnightUtc === null) throw new Error(`invalid day label ${label}`);
	const { day } = release.parameters;
	return day === 'utc' ? midnightUtc : zonedMidnight(label, midnightUtc, day.timeZone);
}

/**
 * Local midnight of `label` in `timeZone`. The zone's offset is read at a first guess and once
 * more at the corrected instant, then the result is checked. America/New_York changes offset at
 * 02:00, so its midnight always exists and is unique.
 */
function zonedMidnight(label: DayLabel, midnightUtc: number, timeZone: DayTimeZone): number {
	let instant = midnightUtc;
	for (let pass = 0; pass < 2; pass += 1) instant = midnightUtc - offsetMs(instant, timeZone);
	const local = wallClock(instant, timeZone);
	if (local.date !== label || local.minuteOfDay !== 0) {
		throw new Error(`${label} has no unique 00:00 in ${timeZone}`);
	}
	return instant;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant` (negative west of Greenwich). */
function offsetMs(instant: number, timeZone: DayTimeZone): number {
	const { date, minuteOfDay } = wallClock(instant, timeZone);
	const wallAsUtc = (parseUtcDate(date) ?? Number.NaN) + minuteOfDay * MINUTE_MS;
	return wallAsUtc - Math.floor(instant / MINUTE_MS) * MINUTE_MS;
}

const formatters = new Map<DayTimeZone, Intl.DateTimeFormat>();

/** The local date and minute of day at `instant` in `timeZone`, from the platform's tz data. */
function wallClock(
	instant: number,
	timeZone: DayTimeZone,
): { date: DayLabel; minuteOfDay: number } {
	let formatter = formatters.get(timeZone);
	if (formatter === undefined) {
		formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		});
		formatters.set(timeZone, formatter);
	}
	const parts = formatter.formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) => {
		const value = parts.find((p) => p.type === type)?.value;
		if (value === undefined) throw new Error(`no ${type} formatting ${instant} in ${timeZone}`);
		return value;
	};
	return {
		date: `${part('year')}-${part('month')}-${part('day')}`,
		minuteOfDay: Number(part('hour')) * 60 + Number(part('minute')),
	};
}
