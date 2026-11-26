/**
 * The daily prints: an immutable, hashed statement of day D's value, built only from day D's round
 * receipts after the day's cutoff. A settlement print (`adi.daily-print/1`) can be corrected; an
 * indicative print (`adi.daily-print/2`, design §4) is never revised. The day and its release are
 * resolved by the entry point (settle, correct, reproduce, the indicative builder) and passed in;
 * nothing here looks them up.
 */
import { settlesAt, type SettlementDay } from './calendar';
import { aggregateDay, settledStatus, type DayAggregate } from './day';
import type { IndicativeAdmission } from './indicative';
import { hashJson } from './json';
import { identityOf, type Identity } from './methodology';
import {
	indicativePrintSchema,
	printSchema,
	type Correction,
	type DailyPrint,
	type HistoryEntry,
	type IndicativePrint,
	type RoundSummary,
} from './schemas';

export const PRINT_SCHEMA = 'adi.daily-print/1' as const;
/** Zoned days, settlement and indicative alike, use the second print schema. */
export const ZONED_PRINT_SCHEMA = 'adi.daily-print/2' as const;

/** Revision 1 is the settlement. Any later revision is a correction and must say why. */
export type PrintRevision = { revision: 1 } | { revision: number; correction: Correction };

/** `Omit` applied to each member of a union, so each print schema keeps its own fields. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Everything a print states except its revision: the day computed from its rounds. */
export type PrintBody = OmitEach<DailyPrint, 'revision' | 'correction' | 'printHash'>;

export function buildPrint(
	settlementDay: SettlementDay,
	rounds: readonly RoundSummary[],
	revision: PrintRevision,
): DailyPrint {
	return finalizePrint(printBody(settlementDay, rounds), revision);
}

/** The aggregation step of a print: everything but its revision, computed from the rounds. */
export function printBody(
	settlementDay: SettlementDay,
	rounds: readonly RoundSummary[],
): PrintBody {
	const { release, window } = settlementDay;
	// Settlement admits exactly the day's own release (settlement rule 4).
	const computed = computeDay(settlementDay, rounds, [identityOf(release)]);
	const stated = {
		date: window.date,
		methodologyVersion: computed.methodologyVersion,
		parameterHash: computed.parameterHash,
		settlesAt: settlesAt(window).toISOString(),
		coverage: computed.coverage,
		result: computed.result,
		rounds: computed.rounds,
	};
	// A UTC day keeps v1's frozen shape; a zoned day also states its standing and window.
	return release.parameters.day === 'utc'
		? { schema: PRINT_SCHEMA, ...stated }
		: {
				schema: ZONED_PRINT_SCHEMA,
				standing: 'settlement',
				day: release.parameters.day.timeZone,
				window: { start: window.start.toISOString(), end: window.end.toISOString() },
				...stated,
			};
}

/**
 * The indicative print of `day` (design §4): the same computation as a settlement print, over the
 * rounds `admission` admits, frozen once admission for the day has closed and never revised.
 */
export function buildIndicativePrint(
	day: SettlementDay,
	rounds: readonly RoundSummary[],
	admission: IndicativeAdmission,
): IndicativePrint {
	const { release, window } = day;
	if (release.parameters.day === 'utc') {
		throw new Error(`${release.parameters.version} has UTC days, so no indicative series`);
	}
	const unsigned: Omit<IndicativePrint, 'printHash'> = {
		schema: ZONED_PRINT_SCHEMA,
		date: window.date,
		standing: 'indicative',
		day: release.parameters.day.timeZone,
		window: { start: window.start.toISOString(), end: window.end.toISOString() },
		freezesAt: settlesAt(window).toISOString(),
		admission: { policy: admission.policy, accepts: [...admission.accepts] },
		...computeDay(day, rounds, admission.accepts),
	};
	return indicativePrintSchema.parse({ ...unsigned, printHash: hashJson(unsigned) });
}

/** What every print states about its day, computed from the rounds `admitted` lets count. */
function computeDay(
	settlementDay: SettlementDay,
	rounds: readonly RoundSummary[],
	admitted: readonly Identity[],
): Pick<PrintBody, 'methodologyVersion' | 'parameterHash' | 'coverage' | 'result' | 'rounds'> {
	const day = aggregateDay(settlementDay, rounds, settlementDay.window.end, admitted);
	// A day is computed under one methodology: any round outside it suspends the day, whatever
	// the coverage.
	const { parameters, parameterHash } = day.methodology;
	const status =
		day.foreignMethodologies.length > 0
			? 'suspended'
			: settledStatus(day.coverage, parameters.coverage);
	return {
		methodologyVersion: parameters.version,
		parameterHash,
		coverage: day.coverage,
		result:
			status === 'suspended'
				? { status, reason: suspensionReason(day) }
				: {
						status,
						value: day.value,
						groundStopValue: day.groundStopValue,
						airports: day.airports,
						hourly: day.hourly,
					},
		rounds: [...rounds]
			.sort((a, b) => a.roundId.localeCompare(b.roundId))
			.map((round) => ({
				roundId: round.roundId,
				receiptHash: round.receiptHash,
				status: round.observation.status,
			})),
	};
}

/** Adds the revision to a computed body, hashes it and validates it against the print schema. */
export function finalizePrint(body: PrintBody, revision: PrintRevision): DailyPrint {
	const unsigned = {
		...body,
		revision: revision.revision,
		correction: 'correction' in revision ? revision.correction : null,
	};
	// The schema owns the print's invariants (revision 1 ⇔ no correction, a stated reason, timing).
	return printSchema.parse({ ...unsigned, printHash: hashJson(unsigned) });
}

function suspensionReason(day: DayAggregate): string {
	if (day.foreignMethodologies.length > 0) {
		const found = day.foreignMethodologies
			.map((m) => `${m.rounds} under ${m.methodologyVersion} (${m.parameterHash})`)
			.join(', ');
		const expected = day.admitted
			.map((m) => `${m.methodologyVersion} (${m.parameterHash})`)
			.join(' or ');
		return `mixed methodology: ${found}, not ${expected}; a day settles under one methodology`;
	}
	const { validRounds, slotsPerDay } = day.coverage;
	return `coverage ${validRounds}/${slotsPerDay} valid rounds is below ${day.methodology.parameters.coverage.degradedMinPercent}%`;
}

export function printHashMatches(print: DailyPrint | IndicativePrint): boolean {
	const { printHash, ...unsigned } = print;
	return hashJson(unsigned) === printHash;
}

export function historyEntryOf(print: DailyPrint): HistoryEntry {
	const settled = print.result.status === 'suspended' ? null : print.result;
	return {
		date: print.date,
		revision: print.revision,
		status: print.result.status,
		value: settled === null ? null : settled.value,
		groundStopValue: settled === null ? null : settled.groundStopValue,
		coveragePercent: print.coverage.percent,
		printHash: print.printHash,
	};
}
