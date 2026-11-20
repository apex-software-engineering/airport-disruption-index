import { METHODOLOGY, PARAMETER_HASH, type PanelAirport } from '@/lib/index/methodology';
import type { RoundSummary } from '@/lib/index/schemas';
import { slotStartOf } from '@/lib/index/time';

export const DAY = '2026-11-17';

type Active = { airport: PanelAirport; gs?: boolean; gdp?: boolean };

/** A round summary for slot `slot` of DAY, fetched `delaySeconds` into the slot. */
export function validRound(slot: number, active: Active[] = [], delaySeconds = 3): RoundSummary {
	return summary(slot, delaySeconds, {
		status: 'valid',
		feedUpdateTime: slotStartOf(DAY, slot).toISOString(),
		active: active.map((a) => ({
			airport: a.airport,
			groundStop: a.gs ?? false,
			groundDelayProgram: a.gdp ?? false,
		})),
	});
}

export function invalidRound(slot: number, delaySeconds = 3): RoundSummary {
	return summary(slot, delaySeconds, { status: 'invalid', reason: 'http_status' });
}

function summary(
	slot: number,
	delaySeconds: number,
	observation: RoundSummary['observation'],
): RoundSummary {
	const start = slotStartOf(DAY, slot);
	return {
		roundId: `${start.toISOString().slice(0, 16)}Z`,
		fetchedAt: new Date(start.getTime() + delaySeconds * 1000).toISOString(),
		receiptHash: (
			slot.toString(16).padStart(4, '0') + delaySeconds.toString(16).padStart(4, '0')
		).repeat(8),
		methodologyVersion: METHODOLOGY.version,
		parameterHash: PARAMETER_HASH,
		observation,
	};
}

/** Valid rounds for every slot in [from, to). */
export function validRange(from: number, to: number, active: Active[] = []): RoundSummary[] {
	return Array.from({ length: to - from }, (_, i) => validRound(from + i, active));
}
