import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';
import { Facts, Mono, Section, Table } from '@/components/ui';
import { METHODOLOGY, PARAMETER_HASH } from '@/lib/index/methodology';

export const metadata: Metadata = { title: 'Methodology' };

/** The prose is docs/methodology.md; the parameters block is the versioned module itself. */
export default function MethodologyPage() {
	const { carry, coverage, settlement } = METHODOLOGY;
	return (
		<>
			<DocBody name='methodology' />
			<Section id='parameters' title='Parameters in force'>
				<p className='text-ink-muted mb-4 text-sm'>
					Read from the methodology module the calculation uses, and served as JSON at{' '}
					<a href='/api/v1/methodology'>/api/v1/methodology</a>.
				</p>
				<Facts
					rows={[
						{ term: 'Version', detail: METHODOLOGY.version },
						{ term: 'Parameter hash', detail: <Mono>{PARAMETER_HASH}</Mono> },
						{ term: 'Source', detail: <Mono>{METHODOLOGY.source.url}</Mono> },
						{
							term: 'Day',
							detail: `UTC, ${METHODOLOGY.slotsPerDay} slots of ${METHODOLOGY.slotMinutes} minutes`,
						},
						{
							term: 'Airport-minutes per active slot',
							detail: String(METHODOLOGY.minutesPerActiveSlot),
						},
						{ term: 'Headline programs', detail: METHODOLOGY.programs.headline.join(', ') },
						{ term: 'GS-only programs', detail: METHODOLOGY.programs.groundStopOnly.join(', ') },
						{
							term: 'Valid observation',
							detail: `HTTP ${METHODOLOGY.observation.requireHttpStatus}, feed at most ${METHODOLOGY.observation.maxFeedAgeSeconds} s old and ${METHODOLOGY.observation.maxFeedLeadSeconds} s ahead`,
						},
						{
							term: 'Carry',
							detail: `at most ${carry.maxCarriedSlots} slots, ${carry.crossesDayBoundary ? 'crossing' : 'never crossing'} the day boundary`,
						},
						{
							term: 'Coverage thresholds',
							detail: `final ≥ ${coverage.finalMinPercent}%, degraded ≥ ${coverage.degradedMinPercent}%, else suspended`,
						},
						{
							term: 'Settlement cutoff',
							detail: `${settlement.cutoffMinutesAfterDayEnd} minutes after the UTC day ends`,
						},
						{ term: 'Revisions', detail: settlement.revisions },
					]}
				/>
				<div className='mt-6'>
					<Table
						caption='Panel airports in rank order'
						head={['Rank', 'Airport']}
						rows={METHODOLOGY.panel.map((airport, index) => [String(index + 1), airport])}
					/>
				</div>
			</Section>
		</>
	);
}
