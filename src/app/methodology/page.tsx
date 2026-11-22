import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';
import { Facts, Mono, Section, Table } from '@/components/ui';
import { CURRENT_ADAPTER } from '@/lib/index/adapters';
import { collectingRelease } from '@/lib/index/calendar';
import type { MethodologyParameters } from '@/lib/index/methodology';

export const metadata: Metadata = { title: 'Methodology' };

/** Re-rendered hourly, so the parameters shown follow a release's effective day. */
export const revalidate = 3600;

/** The prose is docs/methodology.md; the parameters block is the versioned module itself. */
export default function MethodologyPage() {
	const { parameters, parameterHash } = collectingRelease(new Date());
	const { carry, coverage, settlement } = parameters;
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
						{ term: 'Version', detail: parameters.version },
						{ term: 'Parameter hash', detail: <Mono>{parameterHash}</Mono> },
						{
							term: 'Source at release',
							detail: <Mono>{parameters.source.url}</Mono>,
						},
						{
							term: 'Active source adapter',
							detail: (
								<>
									<Mono>{CURRENT_ADAPTER.version}</Mono>, fetching{' '}
									<Mono>{CURRENT_ADAPTER.url}</Mono> (an adapter fix can change this without a
									methodology release; each receipt records its own)
								</>
							),
						},
						{
							term: 'Day',
							detail: describeDay(parameters),
						},
						{
							term: 'Airport-minutes per active slot',
							detail: String(parameters.minutesPerActiveSlot),
						},
						{ term: 'Headline programs', detail: parameters.programs.headline.join(', ') },
						{ term: 'GS-only programs', detail: parameters.programs.groundStopOnly.join(', ') },
						{
							term: 'Valid observation',
							detail: `HTTP ${parameters.observation.requireHttpStatus}, feed at most ${parameters.observation.maxFeedAgeSeconds} s old and ${parameters.observation.maxFeedLeadSeconds} s ahead`,
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
						rows={parameters.panel.map((airport, index) => [String(index + 1), airport])}
					/>
				</div>
			</Section>
		</>
	);
}

function describeDay(parameters: MethodologyParameters): string {
	const slots = `slots of ${parameters.slotMinutes} minutes`;
	return parameters.day === 'utc'
		? `UTC, ${parameters.slotsPerDay} ${slots}`
		: `${parameters.day.timeZone} civil day, 288 ${slots} (276 or 300 on a DST change)`;
}
