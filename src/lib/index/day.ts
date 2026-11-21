/**
 * The index math for one UTC day: pick one round per slot, run the carry/suspend ladder, and
 * count airport-minutes. Pure; the same function serves the running value and the settlement.
 */
import { METHODOLOGY, PANEL, PARAMETER_HASH, type Program } from './methodology';
import type {
	AirportMinutes,
	AirportState,
	Coverage,
	HourBucket,
	RoundSummary,
	SettledStatus,
} from './schemas';
import { elapsedSlots, parseRoundId, slotStartOf, type RoundId, type UtcDate } from './time';

export type SlotState =
	| { status: 'observed'; roundId: RoundId; active: readonly AirportState[] }
	| {
			status: 'carried';
			fromRoundId: RoundId;
			slotsCarried: number;
			active: readonly AirportState[];
	  }
	| { status: 'missing' }
	| { status: 'pending' };

/** Rounds of the day collected under a methodology other than the one this code computes. */
export type ForeignMethodology = {
	methodologyVersion: string;
	parameterHash: string;
	rounds: number;
};

export type DayAggregate = {
	date: UtcDate;
	slots: SlotState[];
	value: number;
	groundStopValue: number;
	airports: AirportMinutes[];
	hourly: HourBucket[];
	coverage: Coverage;
	/** Empty unless the day mixes methodologies; such a day cannot settle (see print.ts). */
	foreignMethodologies: ForeignMethodology[];
};

const SLOTS_PER_HOUR = 60 / METHODOLOGY.slotMinutes;

/**
 * Aggregates `rounds` for `date` as of `asOf`. Slots that have not ended by `asOf` and have no
 * valid round are `pending`; pass the end of the day (or later) to settle.
 */
export function aggregateDay(
	date: UtcDate,
	rounds: readonly RoundSummary[],
	asOf: Date,
): DayAggregate {
	const { chosen, foreignMethodologies } = roundsBySlot(date, rounds);
	const slots = runLadder(chosen, elapsedSlots(date, asOf));
	const airports = PANEL.map((airport) => ({ airport, airportMinutes: 0, groundStopMinutes: 0 }));
	const hourly: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
		hourStart: slotStartOf(date, hour * SLOTS_PER_HOUR).toISOString(),
		airportMinutes: 0,
		groundStopMinutes: 0,
		observed: 0,
		carried: 0,
		missing: 0,
		pending: 0,
	}));
	slots.forEach((slot, index) => {
		const hour = hourly[Math.floor(index / SLOTS_PER_HOUR)];
		if (hour === undefined) throw new Error(`slot ${index} outside the day`);
		hour[slot.status] += 1;
		if (slot.status !== 'observed' && slot.status !== 'carried') return;
		for (const state of slot.active) {
			const row = airports.find((r) => r.airport === state.airport);
			if (row === undefined) throw new Error(`${state.airport} is not on the panel`);
			const programs = activePrograms(state);
			if (programs.some((p) => includes(METHODOLOGY.programs.headline, p))) {
				row.airportMinutes += METHODOLOGY.minutesPerActiveSlot;
				hour.airportMinutes += METHODOLOGY.minutesPerActiveSlot;
			}
			if (programs.some((p) => includes(METHODOLOGY.programs.groundStopOnly, p))) {
				row.groundStopMinutes += METHODOLOGY.minutesPerActiveSlot;
				hour.groundStopMinutes += METHODOLOGY.minutesPerActiveSlot;
			}
		}
	});
	const total = (key: 'airportMinutes' | 'groundStopMinutes') =>
		airports.reduce((sum, row) => sum + row[key], 0);
	return {
		date,
		slots,
		value: total('airportMinutes'),
		groundStopValue: total('groundStopMinutes'),
		airports,
		hourly,
		coverage: coverageOf(slots),
		foreignMethodologies,
	};
}

/**
 * Places each round in its slot. The archive keeps one receipt per round id (the first valid one
 * written wins), so two rounds for one slot or a round from another day are a bug in the caller,
 * not data, and throw. A round under another methodology version or parameter hash is data (a
 * release landed mid-day, or the day predates this code): it takes no slot, so it counts as not
 * received, and it is tallied so the day can say why it does not settle.
 */
function roundsBySlot(
	date: UtcDate,
	rounds: readonly RoundSummary[],
): { chosen: (RoundSummary | null)[]; foreignMethodologies: ForeignMethodology[] } {
	const chosen: (RoundSummary | null)[] = Array.from(
		{ length: METHODOLOGY.slotsPerDay },
		() => null,
	);
	const filled = new Set<number>();
	const foreign = new Map<string, ForeignMethodology>();
	for (const round of rounds) {
		const id = parseRoundId(round.roundId);
		if (id === null || id.date !== date)
			throw new Error(`round ${round.roundId} is not on ${date}`);
		if (filled.has(id.slotIndex)) throw new Error(`two rounds for slot ${round.roundId}`);
		filled.add(id.slotIndex);
		const { methodologyVersion, parameterHash } = round;
		if (methodologyVersion === METHODOLOGY.version && parameterHash === PARAMETER_HASH) {
			chosen[id.slotIndex] = round;
			continue;
		}
		const key = `${methodologyVersion} ${parameterHash}`;
		const tally = foreign.get(key) ?? { methodologyVersion, parameterHash, rounds: 0 };
		foreign.set(key, { ...tally, rounds: tally.rounds + 1 });
	}
	const foreignMethodologies = [...foreign.values()].sort((x, y) =>
		`${x.methodologyVersion} ${x.parameterHash}`.localeCompare(
			`${y.methodologyVersion} ${y.parameterHash}`,
		),
	);
	return { chosen, foreignMethodologies };
}

/**
 * The carry/suspend ladder. A slot with a valid round is `observed`. A slot without one that
 * has ended carries the last observed state for at most `maxCarriedSlots` slots, then is
 * `missing` and contributes nothing. The ladder restarts every UTC day.
 */
function runLadder(chosen: readonly (RoundSummary | null)[], elapsed: number): SlotState[] {
	let last: { roundId: RoundId; slot: number; active: readonly AirportState[] } | null = null;
	return chosen.map((round, slot): SlotState => {
		if (round !== null && round.observation.status === 'valid') {
			last = { roundId: round.roundId, slot, active: round.observation.active };
			return { status: 'observed', roundId: round.roundId, active: round.observation.active };
		}
		if (slot >= elapsed) return { status: 'pending' };
		if (last !== null && slot - last.slot <= METHODOLOGY.carry.maxCarriedSlots) {
			return {
				status: 'carried',
				fromRoundId: last.roundId,
				slotsCarried: slot - last.slot,
				active: last.active,
			};
		}
		return { status: 'missing' };
	});
}

function activePrograms(state: AirportState): Program[] {
	const programs: Program[] = [];
	if (state.groundStop) programs.push('ground_stop');
	if (state.groundDelayProgram) programs.push('ground_delay_program');
	return programs;
}

function includes(list: readonly Program[], program: Program): boolean {
	return list.includes(program);
}

function coverageOf(slots: readonly SlotState[]): Coverage {
	const countOf = (status: SlotState['status']) => slots.filter((s) => s.status === status).length;
	const validRounds = countOf('observed');
	return {
		slotsPerDay: METHODOLOGY.slotsPerDay,
		validRounds,
		carriedSlots: countOf('carried'),
		missingSlots: countOf('missing'),
		pendingSlots: countOf('pending'),
		percent: Math.round((validRounds / METHODOLOGY.slotsPerDay) * 10_000) / 100,
	};
}

/** Day status from coverage, compared in integers so no float rounding can move a boundary. */
export function settledStatus(validRounds: number): SettledStatus {
	const { finalMinPercent, degradedMinPercent } = METHODOLOGY.coverage;
	const scaled = validRounds * 100;
	if (scaled >= finalMinPercent * METHODOLOGY.slotsPerDay) return 'final';
	if (scaled >= degradedMinPercent * METHODOLOGY.slotsPerDay) return 'degraded';
	return 'suspended';
}
