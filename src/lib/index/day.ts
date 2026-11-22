/**
 * The index math for one settlement day: pick one round per slot, run the carry/suspend ladder,
 * and count airport-minutes. Pure; the same function serves the running value and the settlement.
 * The day and its release are resolved by the caller and passed in; nothing here looks them up.
 */
import { elapsedSlots, slotIndexIn, slotStartIn, type SettlementDay } from './calendar';
import {
	admits,
	SLOT_MINUTES,
	type Identity,
	type Methodology,
	type MethodologyParameters,
	type Program,
} from './methodology';
import type {
	AirportMinutes,
	AirportState,
	Coverage,
	HourBucket,
	RoundSummary,
	SettledStatus,
} from './schemas';
import { parseRoundId, type RoundId } from './time';

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

/** Rounds of the day collected under a methodology other than the one in effect that day. */
export type ForeignMethodology = {
	methodologyVersion: string;
	parameterHash: string;
	rounds: number;
};

export type DayAggregate = {
	date: string;
	/** The methodology the day is computed under. */
	methodology: Methodology;
	/** The identities whose rounds count; any other round is foreign. */
	admitted: readonly Identity[];
	slots: SlotState[];
	value: number;
	groundStopValue: number;
	airports: AirportMinutes[];
	hourly: HourBucket[];
	coverage: Coverage;
	/** Empty unless the day mixes methodologies; such a day cannot settle (see print.ts). */
	foreignMethodologies: ForeignMethodology[];
};

const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;

/**
 * Aggregates `rounds` for `day` as of `asOf`, under the day's release, counting only rounds that
 * record one of the `admitted` identities: the day's own for a settlement day (strict, settlement
 * rule 4), the indicative admission policy's for an indicative one. Slots that have not ended by
 * `asOf` and have no valid round are `pending`; pass the end of the day (or later) to settle.
 */
export function aggregateDay(
	day: SettlementDay,
	rounds: readonly RoundSummary[],
	asOf: Date,
	admitted: readonly Identity[],
): DayAggregate {
	const { release: methodology, window } = day;
	const parameters = methodology.parameters;
	const { chosen, foreignMethodologies } = roundsBySlot(window, rounds, admitted);
	const slots = runLadder(chosen, elapsedSlots(window, asOf), parameters.carry.maxCarriedSlots);
	const airports = parameters.panel.map((airport) => ({
		airport,
		airportMinutes: 0,
		groundStopMinutes: 0,
	}));
	const hourly: HourBucket[] = Array.from({ length: window.slots / SLOTS_PER_HOUR }, (_, hour) => ({
		hourStart: slotStartIn(window, hour * SLOTS_PER_HOUR).toISOString(),
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
			const minutes = parameters.minutesPerActiveSlot;
			if (programs.some((p) => parameters.programs.headline.includes(p))) {
				row.airportMinutes += minutes;
				hour.airportMinutes += minutes;
			}
			if (programs.some((p) => parameters.programs.groundStopOnly.includes(p))) {
				row.groundStopMinutes += minutes;
				hour.groundStopMinutes += minutes;
			}
		}
	});
	const total = (key: 'airportMinutes' | 'groundStopMinutes') =>
		airports.reduce((sum, row) => sum + row[key], 0);
	return {
		date: window.date,
		methodology,
		admitted,
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
 * not data, and throw. A round under a methodology other than the day's is data (a collector
 * kept running an older release past a cutover): it takes no slot, so it counts as not
 * received, and it is tallied so the day can say why it does not settle.
 */
function roundsBySlot(
	window: SettlementDay['window'],
	rounds: readonly RoundSummary[],
	admitted: readonly Identity[],
): { chosen: (RoundSummary | null)[]; foreignMethodologies: ForeignMethodology[] } {
	const chosen: (RoundSummary | null)[] = Array.from({ length: window.slots }, () => null);
	const filled = new Set<number>();
	const foreign = new Map<string, ForeignMethodology>();
	for (const round of rounds) {
		const id = parseRoundId(round.roundId);
		const slot = id === null ? null : slotIndexIn(window, id.slotStart);
		if (slot === null) throw new Error(`round ${round.roundId} is not on ${window.date}`);
		if (filled.has(slot)) throw new Error(`two rounds for slot ${round.roundId}`);
		filled.add(slot);
		if (admits(admitted, round)) {
			chosen[slot] = round;
			continue;
		}
		const { methodologyVersion, parameterHash } = round;
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
 * `missing` and contributes nothing. The ladder restarts every settlement day.
 */
function runLadder(
	chosen: readonly (RoundSummary | null)[],
	elapsed: number,
	maxCarriedSlots: number,
): SlotState[] {
	let last: { roundId: RoundId; slot: number; active: readonly AirportState[] } | null = null;
	return chosen.map((round, slot): SlotState => {
		if (round !== null && round.observation.status === 'valid') {
			last = { roundId: round.roundId, slot, active: round.observation.active };
			return { status: 'observed', roundId: round.roundId, active: round.observation.active };
		}
		if (slot >= elapsed) return { status: 'pending' };
		if (last !== null && slot - last.slot <= maxCarriedSlots) {
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

function coverageOf(slots: readonly SlotState[]): Coverage {
	const countOf = (status: SlotState['status']) => slots.filter((s) => s.status === status).length;
	const validRounds = countOf('observed');
	return {
		slotsPerDay: slots.length,
		validRounds,
		carriedSlots: countOf('carried'),
		missingSlots: countOf('missing'),
		pendingSlots: countOf('pending'),
		percent: Math.round((validRounds / slots.length) * 10_000) / 100,
	};
}

/**
 * Day status from coverage, a percentage of the day's own slots. Compared in integers
 * (`valid × 100 ≥ percent × slots`), so no float rounding can move a boundary.
 */
export function settledStatus(
	{ validRounds, slotsPerDay }: Pick<Coverage, 'validRounds' | 'slotsPerDay'>,
	coverage: MethodologyParameters['coverage'],
): SettledStatus {
	const { finalMinPercent, degradedMinPercent } = coverage;
	const scaled = validRounds * 100;
	if (scaled >= finalMinPercent * slotsPerDay) return 'final';
	if (scaled >= degradedMinPercent * slotsPerDay) return 'degraded';
	return 'suspended';
}
