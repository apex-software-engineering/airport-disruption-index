import { Instant, Notice, Section } from '@/components/ui';

import type { Transition } from './index-data';

/**
 * Between the last day of one release and the first day of the next there is no settlement day,
 * so no running value. Collection carries on; its heartbeat is shown with the transition.
 */
export function TransitionNotice({ current }: { current: Transition }) {
	const { previousDay, nextDay, lastRound } = current;
	return (
		<Section title='Between settlement days'>
			<Notice>
				Day {previousDay.date} has ended. Its print settles at{' '}
				<Instant at={previousDay.settlesAt} /> and is due by{' '}
				<Instant at={previousDay.publishBy} punctuation='.' /> The next settlement day,{' '}
				{nextDay.date}, starts at <Instant at={nextDay.startsAt} punctuation='.' /> Rounds collected
				until then belong to no settlement day. Collection continues
				{lastRound === null ? (
					'.'
				) : (
					<>
						: last round {lastRound.roundId}, {lastRound.status}.
					</>
				)}
			</Notice>
		</Section>
	);
}
