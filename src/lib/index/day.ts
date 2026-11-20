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

export type DayAggregate = {
	date: UtcDate;
	slots: SlotState[];
	value: number;
	groundStopValue: number;
	airports: AirportMinutes[];
	hourly: HourBucket[];
	coverage: Coverage;
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
	const chosen = roundsBySlot(date, rounds);
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
	};
}

/**
 * Places each round in its slot. The archive keeps one receipt per round id (the first valid one
 * written wins), so two rounds for one slot, a round from another day, or one under another
 * parameter set are a bug in the caller, not data, and throw.
 */
function roundsBySlot(date: UtcDate, rounds: readonly RoundSummary[]): (RoundSummary | null)[] {
	const bySlot: (RoundSummary | null)[] = Array.from(
		{ length: METHODOLOGY.slotsPerDay },
		() => null,
	);
	for (const round of rounds) {
		const id = parseRoundId(round.roundId);
		if (id === null || id.date !== date)
			throw new Error(`round ${round.roundId} is not on ${date}`);
		if (
			round.methodologyVersion !== METHODOLOGY.version ||
			round.parameterHash !== PARAMETER_HASH
		) {
			throw new Error(
				`round ${round.roundId} uses methodology ${round.methodologyVersion}, not ${METHODOLOGY.version}`,
			);
		}
		if (bySlot[id.slotIndex] != null) throw new Error(`two rounds for slot ${round.roundId}`);
		bySlot[id.slotIndex] = round;
	}
	return bySlot;
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
