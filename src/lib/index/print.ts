/**
 * The daily settlement print: an immutable, hashed statement of day D's value, built only from
 * day D's round receipts after the settlement cutoff.
 */
import { aggregateDay, settledStatus, type DayAggregate } from './day';
import { hashJson } from './json';
import { METHODOLOGY, PARAMETER_HASH } from './methodology';
import { printSchema, type DailyPrint, type HistoryEntry, type RoundSummary } from './schemas';
import { dayStartMs, settlementCutoff, type UtcDate } from './time';

export const PRINT_SCHEMA = 'adi.daily-print/1' as const;

/** Revision 1 is the settlement. Any later revision is a correction and must say why. */
export type PrintRevision =
	{ revision: 1 } | { revision: number; supersedesPrintHash: string; reason: string };

export function buildPrint(
	date: UtcDate,
	rounds: readonly RoundSummary[],
	revision: PrintRevision,
): DailyPrint {
	const dayEnd = new Date(dayStartMs(date) + 86_400_000);
	const day = aggregateDay(date, rounds, dayEnd);
	// A day settles under one methodology: any round under another suspends it, whatever the coverage.
	const status =
		day.foreignMethodologies.length > 0 ? 'suspended' : settledStatus(day.coverage.validRounds);
	const unsigned: Omit<DailyPrint, 'printHash'> = {
		schema: PRINT_SCHEMA,
		date,
		revision: revision.revision,
		correction:
			'reason' in revision
				? { supersedesPrintHash: revision.supersedesPrintHash, reason: revision.reason }
				: null,
		methodologyVersion: METHODOLOGY.version,
		parameterHash: PARAMETER_HASH,
		settlesAt: settlementCutoff(date).toISOString(),
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
	// The schema owns the print's invariants (revision 1 ⇔ no correction, a stated reason).
	return printSchema.parse({ ...unsigned, printHash: hashJson(unsigned) });
}

function suspensionReason(day: DayAggregate): string {
	if (day.foreignMethodologies.length > 0) {
		const found = day.foreignMethodologies
			.map((m) => `${m.rounds} under ${m.methodologyVersion} (${m.parameterHash})`)
			.join(', ');
		return `mixed methodology: ${found}, not ${METHODOLOGY.version} (${PARAMETER_HASH}); a day settles under one methodology`;
	}
	const { validRounds, slotsPerDay } = day.coverage;
	return `coverage ${validRounds}/${slotsPerDay} valid rounds is below ${METHODOLOGY.coverage.degradedMinPercent}%`;
}

export function printHashMatches(print: DailyPrint): boolean {
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
