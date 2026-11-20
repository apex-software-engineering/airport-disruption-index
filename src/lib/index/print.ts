/**
 * The daily settlement print: an immutable, hashed statement of day D's value, built only from
 * day D's round receipts after the settlement cutoff.
 */
import { aggregateDay, settledStatus } from './day';
import { hashJson } from './json';
import { METHODOLOGY, PARAMETER_HASH } from './methodology';
import type { DailyPrint, HistoryEntry, RoundSummary } from './schemas';
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
	if ('reason' in revision && (revision.revision < 2 || revision.reason.trim() === '')) {
		throw new Error('a correction print needs revision 2 or later and a stated reason');
	}
	const dayEnd = new Date(dayStartMs(date) + 86_400_000);
	const day = aggregateDay(date, rounds, dayEnd);
	const status = settledStatus(day.coverage.validRounds);
	const { degradedMinPercent } = METHODOLOGY.coverage;
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
				? {
						status,
						reason: `coverage ${day.coverage.validRounds}/${day.coverage.slotsPerDay} valid rounds is below ${degradedMinPercent}%`,
					}
				: {
						status,
						value: day.value,
						groundStopValue: day.groundStopValue,
						airports: day.airports,
						hourly: day.hourly,
					},
		rounds: [...rounds]
			.sort((a, b) => a.roundId.localeCompare(b.roundId) || a.fetchedAt.localeCompare(b.fetchedAt))
			.map((round) => ({
				roundId: round.roundId,
				receiptHash: round.receiptHash,
				status: round.observation.status,
			})),
	};
	return { ...unsigned, printHash: hashJson(unsigned) };
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
