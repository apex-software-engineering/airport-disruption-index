import { settlementDay, slotStartIn } from '@/lib/index/calendar';
import type { Correction, RoundSummary } from '@/lib/index/schemas';
import type { UtcDate } from '@/lib/index/time';

export const DAY = '2026-11-17';

type Active = { airport: string; gs?: boolean; gdp?: boolean };

/**
 * A round summary for slot `slot` of `day`, fetched `delaySeconds` into the slot, under the
 * methodology in effect on that day.
 */
export function validRound(
	slot: number,
	active: Active[] = [],
	delaySeconds = 3,
	day: UtcDate = DAY,
): RoundSummary {
	return summary(day, slot, delaySeconds, {
		status: 'valid',
		feedUpdateTime: slotStartIn(settlementDay(day).window, slot).toISOString(),
		active: active.map((a) => ({
			airport: a.airport,
			groundStop: a.gs ?? false,
			groundDelayProgram: a.gdp ?? false,
		})),
		unrecognized: [],
	});
}

export function invalidRound(slot: number, delaySeconds = 3): RoundSummary {
	return summary(DAY, slot, delaySeconds, { status: 'invalid', reason: 'http_status' });
}

function summary(
	day: UtcDate,
	slot: number,
	delaySeconds: number,
	observation: RoundSummary['observation'],
): RoundSummary {
	const { release, window } = settlementDay(day);
	const start = slotStartIn(window, slot);
	const { parameters, parameterHash } = release;
	return {
		roundId: `${start.toISOString().slice(0, 16)}Z`,
		fetchedAt: new Date(start.getTime() + delaySeconds * 1000).toISOString(),
		receiptHash: (
			slot.toString(16).padStart(4, '0') + delaySeconds.toString(16).padStart(4, '0')
		).repeat(8),
		methodologyVersion: parameters.version,
		parameterHash,
		observation,
	};
}

/** Valid rounds for every slot of `day` in [from, to). */
export function validRange(
	from: number,
	to: number,
	active: Active[] = [],
	day: UtcDate = DAY,
): RoundSummary[] {
	return Array.from({ length: to - from }, (_, i) => validRound(from + i, active, 3, day));
}

/** A correction of a `DAY` print, issued at DAY+1 12:00Z, inside the corrections window. */
export function correctionOf(supersedesPrintHash: string, reason = 'test correction'): Correction {
	return {
		supersedesPrintHash,
		reason,
		issuedAt: '2026-11-18T12:00:00.000Z',
		windowOverride: null,
	};
}
