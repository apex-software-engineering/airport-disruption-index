import { SETTLEMENT_CUTOFF_MINUTES, SLOT_MINUTES, SLOTS_PER_DAY } from './methodology';

const SLOT_MS = SLOT_MINUTES * 60_000;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD`, a UTC calendar day. */
export type UtcDate = string;
/** Slot start at minute precision, e.g. `2026-11-17T20:45Z`. */
export type RoundId = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ROUND_ID_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})Z$/;

export function slotStartMs(at: Date): number {
	return Math.floor(at.getTime() / SLOT_MS) * SLOT_MS;
}

export function roundIdFor(at: Date): RoundId {
	return `${new Date(slotStartMs(at)).toISOString().slice(0, 16)}Z`;
}

export function utcDateOf(at: Date): UtcDate {
	return at.toISOString().slice(0, 10);
}

/** Start of a UTC day in epoch ms, or null when `date` is not a real `YYYY-MM-DD` day. */
export function parseUtcDate(date: string): number | null {
	const match = DATE_PATTERN.exec(date);
	if (!match) return null;
	const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return utcDateOf(new Date(ms)) === date ? ms : null;
}

export function dayStartMs(date: UtcDate): number {
	const ms = parseUtcDate(date);
	if (ms === null) throw new Error(`invalid UTC date ${date}`);
	return ms;
}

export function addDays(date: UtcDate, days: number): UtcDate {
	return utcDateOf(new Date(dayStartMs(date) + days * DAY_MS));
}

/** Parsed round id, or null when the string is not a slot-aligned round id. */
export function parseRoundId(
	id: string,
): { date: UtcDate; slotIndex: number; slotStart: Date } | null {
	const match = ROUND_ID_PATTERN.exec(id);
	if (!match || match[1] === undefined || parseUtcDate(match[1]) === null) return null;
	const hour = Number(match[2]);
	const minute = Number(match[3]);
	if (hour > 23 || minute > 59 || minute % SLOT_MINUTES !== 0) return null;
	const slotIndex = (hour * 60 + minute) / SLOT_MINUTES;
	return {
		date: match[1],
		slotIndex,
		slotStart: new Date(dayStartMs(match[1]) + slotIndex * SLOT_MS),
	};
}

export function slotStartOf(date: UtcDate, slotIndex: number): Date {
	return new Date(dayStartMs(date) + slotIndex * SLOT_MS);
}

/** Number of slots of `date` that have fully ended at `asOf` (0..slotsPerDay). */
export function elapsedSlots(date: UtcDate, asOf: Date): number {
	const elapsed = Math.floor((asOf.getTime() - dayStartMs(date)) / SLOT_MS);
	return Math.min(SLOTS_PER_DAY, Math.max(0, elapsed));
}

/** When the print for `date` may be built: day end plus the settlement cutoff. */
export function settlementCutoff(date: UtcDate): Date {
	return new Date(dayStartMs(date) + DAY_MS + SETTLEMENT_CUTOFF_MINUTES * 60_000);
}

/**
 * The print for a day is published by this long after the day ends. A publication commitment,
 * not a methodology parameter: it decides when a print appears, never what it says, so it is
 * kept out of the parameter hash.
 */
const PUBLICATION_DEADLINE_MINUTES_AFTER_DAY_END = 90;

/** When the print for `date` is due: D+1 01:30Z. A print published later is still the print. */
export function publicationDeadline(date: UtcDate): Date {
	return new Date(dayStartMs(date) + DAY_MS + PUBLICATION_DEADLINE_MINUTES_AFTER_DAY_END * 60_000);
}

/** How long after the settlement cutoff a correction may be issued without an override. */
const CORRECTION_WINDOW_MS = 24 * 3_600_000;

/**
 * Corrections to day D are issued by D+2 00:30Z: 24 hours after the settlement cutoff, which is
 * the earliest the original print can have been published, so the window never runs longer than
 * 24 hours after it. Computed from the day alone, so anyone can check a correction against it.
 */
export function correctionDeadline(date: UtcDate): Date {
	return new Date(settlementCutoff(date).getTime() + CORRECTION_WINDOW_MS);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UPDATE_TIME_PATTERN =
	/^([A-Z][a-z]{2}) +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4}) GMT$/;

/**
 * Parses the feed's `Update_Time` (`Tue Nov 17 20:43:54 2026 GMT`) to an ISO instant.
 * Returns null for anything else, including an impossible date or a wrong weekday.
 */
export function parseFeedUpdateTime(text: string): string | null {
	const match = UPDATE_TIME_PATTERN.exec(text);
	if (!match) return null;
	const [, weekday, monthName, day, hour, minute, second, year] = match;
	const month = MONTHS.indexOf(monthName ?? '');
	if (month < 0) return null;
	const date = new Date(
		Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second)),
	);
	const roundTrips =
		date.getUTCMonth() === month &&
		date.getUTCDate() === Number(day) &&
		date.getUTCHours() === Number(hour) &&
		date.getUTCMinutes() === Number(minute) &&
		date.getUTCSeconds() === Number(second);
	if (!roundTrips || WEEKDAYS[date.getUTCDay()] !== weekday) return null;
	return date.toISOString();
}
