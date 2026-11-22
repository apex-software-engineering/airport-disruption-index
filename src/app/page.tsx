import Link from 'next/link';

import { describeCoverage } from '@/components/coverage';
import { dayName, ZONE_LABEL } from '@/components/day-name';
import { formatInteger, formatPercent } from '@/components/format';
import { HourlyChart } from '@/components/hourly-chart';
import {
	hasValidRound,
	readSiteData,
	RECENT_PRINT_DAYS,
	SETTLED_TONE,
	type HistoryDay,
	type IndicativeDay,
	type Provisional,
} from '@/components/index-data';
import { TransitionNotice } from '@/components/transition';
import {
	Figure,
	Instant,
	Notice,
	PageTitle,
	Section,
	StatusLabel,
	Table,
	UtcDay,
	ZonedDay,
} from '@/components/ui';
import { collectingRelease } from '@/lib/index/calendar';
import { INDICATIVE_SERIES } from '@/lib/index/indicative';
import type { MethodologyParameters } from '@/lib/index/methodology';
import { site } from '@/lib/site';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
	const { current, recent, recentIndicative } = await readSiteData(new Date());
	// The methodology in effect at the same instant as the running value.
	const parameters = collectingRelease(new Date(current.asOf)).parameters;
	return (
		<>
			<PageTitle
				title={site.name}
				lede={`Airport-minutes under FAA ground stops and ground delay programs across ${parameters.panel.length} US hub airports, per ${dayName(parameters)}. Methodology v${parameters.version}.`}
			/>
			{current.status === 'transition' ? (
				<TransitionNotice current={current} />
			) : (
				<Today current={current} />
			)}
			{current.status === 'provisional' && hasValidRound(current) ? (
				<>
					<Section title='Hourly series'>
						<HourlyChart hourly={current.hourly} />
					</Section>
					<Section title='By airport'>
						<Table
							caption={`Airport-minutes by panel airport for ${current.date}`}
							head={['Airport', 'ADI', 'ADI-GS']}
							rows={current.airports.map((row) => [
								row.airport,
								formatInteger(row.airportMinutes),
								formatInteger(row.groundStopMinutes),
							])}
						/>
						<p className='text-ink-subtle mt-2 text-xs'>
							Panel order: CY2024 enplanement rank among the FAA Core 30.
						</p>
					</Section>
				</>
			) : null}
			<RecentPrints days={recent} parameters={parameters} />
			<IndicativePrints days={recentIndicative} />
			<WhatItMeasures parameters={parameters} />
		</>
	);
}

function Today({ current }: { current: Provisional }) {
	const { lastRound } = current;
	const coverage = describeCoverage(current.coverage);
	return (
		<Section title={<UtcDay date={current.date}>Today, {current.date} (UTC)</UtcDay>}>
			{hasValidRound(current) ? (
				<div className='grid gap-6 sm:grid-cols-3'>
					<Figure
						label='ADI, running'
						value={formatInteger(current.value)}
						note='airport-minutes, GS or GDP'
					/>
					<Figure
						label='ADI-GS, running'
						value={formatInteger(current.groundStopValue)}
						note='airport-minutes, GS only'
					/>
					<Figure
						label='Coverage'
						value={coverage.percent}
						note={`${coverage.observed}; ${coverage.ended}`}
					/>
				</div>
			) : (
				<Notice>
					No valid round has been recorded for {current.date} yet, so there is no running value to
					show. The index publishes no number until it has observed the source.
				</Notice>
			)}
			<p className='text-ink-muted mt-6 text-sm'>
				<StatusLabel tone='neutral'>Provisional.</StatusLabel> The running value can still change
				until the day settles at <Instant at={current.settlesAt} punctuation='.' />
				{lastRound === null ? (
					'No round has been recorded today.'
				) : (
					<>
						Last round <a href={lastRound.url}>{lastRound.roundId}</a>, {lastRound.status}, fetched{' '}
						<Instant at={lastRound.fetchedAt} punctuation='.' />
					</>
				)}
				<Link href='/status'>Status</Link>
			</p>
		</Section>
	);
}

function RecentPrints({
	days,
	parameters,
}: {
	days: readonly HistoryDay[];
	parameters: MethodologyParameters;
}) {
	return (
		<Section title='Daily settlement prints'>
			{days.length === 0 ? (
				<Notice>
					No day has settled in the last {RECENT_PRINT_DAYS} days. A day&apos;s print is published{' '}
					{parameters.settlement.cutoffMinutesAfterDayEnd} minutes after the {dayName(parameters)}{' '}
					ends, and the index is live-only from its first production round.
				</Notice>
			) : (
				<Table
					caption='Settled days, newest first'
					head={['Date (UTC)', 'Status', 'ADI', 'ADI-GS', 'Coverage', 'Revision']}
					rows={days.map((day) => [
						// A fixed width for the local line, so filling it cannot resize the column.
						<div key='date' className='w-80'>
							<UtcDay date={day.date}>
								<a href={day.url}>{day.date}</a>
							</UtcDay>
						</div>,
						<StatusLabel key='status' tone={SETTLED_TONE[day.status]}>
							{day.status}
						</StatusLabel>,
						day.value === null ? '—' : formatInteger(day.value),
						day.groundStopValue === null ? '—' : formatInteger(day.groundStopValue),
						formatPercent(day.coveragePercent),
						day.revision,
					])}
				/>
			)}
		</Section>
	);
}

/**
 * The indicative ET series (design §4): labelled with its zone and its standing on every row and
 * heading, so no value here can be read as a settlement value.
 */
function IndicativePrints({ days }: { days: readonly IndicativeDay[] }) {
	return (
		<Section
			title={
				<>
					{INDICATIVE_SERIES.headline} <StatusLabel tone='neutral'>Indicative</StatusLabel>
				</>
			}>
			<p className='text-ink-muted mb-4 max-w-2xl text-sm'>
				Methodology v2.0.0&apos;s America/New_York day, computed from the same archived receipts.{' '}
				<strong className='text-ink'>Indicative: never a settlement value.</strong> Each day is
				frozen once, 30 minutes after it ends, and never revised.{' '}
				<a href='/api/v1/indicative/history'>/api/v1/indicative/history</a>
			</p>
			{days.length === 0 ? (
				<Notice>No indicative day has been frozen in the last {RECENT_PRINT_DAYS} days.</Notice>
			) : (
				<Table
					caption={`${INDICATIVE_SERIES.headline}, newest first`}
					head={[
						'Date (ET)',
						'Status',
						INDICATIVE_SERIES.headline,
						INDICATIVE_SERIES.groundStopOnly,
						'Coverage',
					]}
					rows={days.map((day) => [
						<div key='date' className='w-80'>
							<ZonedDay date={day.date} window={day.window} zone={ZONE_LABEL[day.day]}>
								<a href={day.url}>
									{day.date} ({ZONE_LABEL[day.day]})
								</a>
							</ZonedDay>
						</div>,
						<StatusLabel key='status' tone={SETTLED_TONE[day.status]}>
							{day.status}, indicative
						</StatusLabel>,
						day.value === null ? '—' : formatInteger(day.value),
						day.groundStopValue === null ? '—' : formatInteger(day.groundStopValue),
						formatPercent(day.coveragePercent),
					])}
				/>
			)}
		</Section>
	);
}

function WhatItMeasures({ parameters }: { parameters: MethodologyParameters }) {
	const { slotMinutes, carry, coverage, settlement } = parameters;
	return (
		<Section title='What it measures'>
			<div className='text-ink-muted max-w-2xl space-y-3'>
				<p>
					Every {slotMinutes} minutes the collector reads the FAA NAS Status airport feed once. Each
					panel airport under an active ground stop or ground delay program in that observation adds{' '}
					{parameters.minutesPerActiveSlot} airport-minutes to the day. The headline{' '}
					<strong className='text-ink'>ADI</strong> counts either program; the{' '}
					<strong className='text-ink'>ADI-GS</strong> sub-index counts ground stops only. A day
					ranges from 0 to {formatInteger(parameters.panel.length * 24 * 60)}.
				</p>
				<p>
					A missed observation carries the last valid state for at most {carry.maxCarriedSlots}{' '}
					slots, then counts nothing. A day settles {settlement.cutoffMinutesAfterDayEnd} minutes
					after it ends: final at {coverage.finalMinPercent}% coverage or more, degraded from{' '}
					{coverage.degradedMinPercent}%, and suspended below that. Every round keeps the raw source
					bytes and a hashed receipt, so anyone can recompute a published number.
				</p>
				<p>
					<Link href='/methodology'>Methodology</Link> · <Link href='/docs/api'>API</Link> ·{' '}
					<Link href='/sources'>Sources</Link>
				</p>
			</div>
		</Section>
	);
}
