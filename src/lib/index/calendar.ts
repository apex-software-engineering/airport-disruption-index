/**
 * Settlement days in time. The only code that turns a release and a day label into instants
 * (`dayWindow`), or an instant into a settlement day (`dayAt`) or into the release that collects it
 * (`collectingRelease`). Every deadline is a fixed duration from a day's window, so DST never moves
 * one. Slots stay the 5-minute UTC grid of time.ts: a day is a run of whole slots.
 */
import {
	activeReleases,
	governs,
	SETTLEMENT_CUTOFF_MINUTES,
	settlementReleaseFor,
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
	for (const [index, release] of releases.entries()) {
		const successor = releases[index + 1];
		if (successor === undefined || release.effectiveUntil === null) continue;
		const previous = dayWindow(release, release.effectiveUntil);
		const next = dayWindow(successor, successor.effectiveFrom);
		if (instant >= previous.end && instant < next.start)
			return { kind: 'transition', previous, next };
	}
	throw new Error(`no methodology is in effect at ${instant.toISOString()}`);
}

/**
 * When a release takes effect: the start of its first day under the boundary of the release it
 * replaces (settlement rule 4). v1 took effect at 2026-11-17T00:00Z; v2, replacing v1, at 00:00Z
 * of its first date, five hours before its first ET day starts.
 */
export function effectiveAt(release: Methodology): Date {
	const predecessor = RELEASES[RELEASES.indexOf(release) - 1] ?? release;
	return dayWindow(predecessor, release.effectiveFrom).start;
}

/** The release in effect at `instant`, which every round fetched then is collected under. */
export function collectingRelease(instant: Date): Methodology {
	const release = activeReleases().findLast((r) => effectiveAt(r) <= instant);
	if (release === undefined)
		throw new Error(`no methodology is in effect at ${instant.toISOString()}`);
	return release;
}

/** The UTC storage partitions (`rounds/{date}/`) a window's slots fall in, in order. */
export function partitionsOf(window: DayWindow): UtcDate[] {
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
