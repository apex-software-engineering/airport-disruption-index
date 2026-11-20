/**
 * How the pages word today's coverage. Coverage is valid rounds over every slot of the day, and
 * the slot counts cover the whole day too, so they always add up to `slotsPerDay`. Ended slots
 * are a separate count: an open slot can already hold its valid round.
 */
import type { Coverage } from '@/lib/index/schemas';

import { formatPercent } from './format';

export type TodayCoverage = Coverage & { elapsedSlots: number };

export function describeCoverage(coverage: TodayCoverage) {
	const { slotsPerDay, validRounds, carriedSlots, missingSlots, pendingSlots } = coverage;
	const counted = validRounds + carriedSlots + missingSlots + pendingSlots;
	if (counted !== slotsPerDay) {
		throw new Error(`slot counts add up to ${counted}, not ${slotsPerDay}`);
	}
	return {
		percent: formatPercent(coverage.percent),
		observed: `${validRounds} of ${slotsPerDay} slots observed`,
		slots: `${validRounds} observed, ${carriedSlots} carried, ${missingSlots} missing, ${pendingSlots} pending`,
		ended: `${coverage.elapsedSlots} of ${slotsPerDay} slots ended`,
	};
}
