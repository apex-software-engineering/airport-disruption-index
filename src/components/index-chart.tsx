/**
 * The home page's lead: the headline value and one large line chart of the daily prints, built
 * only from what `/api/v1/history` and `/api/v1/current` serve, so anyone can rebuild it from the
 * links under it. This server half renders the headline, the legend, every tooltip body, the
 * honesty notes and the table twin; `index-chart-plot.tsx` draws the chart and handles input.
 */
import type { ReactNode } from 'react';

import { Mark, PROVISIONAL_DASH, SuspendedHatch, type MarkStatus } from './chart-marks';
import { formatInteger, formatPercent, formatSigned } from './format';
import { IndexChartPlot } from './index-chart-plot';
import { hasValidRound, SETTLED_TONE, type Current, type History } from './index-data';
import {
	chartModel,
	chartPoints,
	type ApiSource,
	type ChartPoint,
	type Headline,
} from './index-series';
import { Instant, Notice, StatusLabel, Table, UtcDay } from './ui';

function todayOf(current: Current) {
	if (current.status !== 'provisional' || !hasValidRound(current)) return null;
	const { date, value, groundStopValue, asOf, coverage } = current;
	return { date, value, groundStopValue, asOf, coveragePercent: coverage.percent };
}

export function IndexChart({
	history,
	current,
	api,
}: {
	history: History;
	current: Current;
	api: ApiSource;
}) {
	const points = chartPoints(history.days, todayOf(current));
	const model = chartModel(points, history.to, api);
	if (model === null) {
		return (
			<Notice>
				No day has settled and today has no running value, so there is nothing to chart yet. Every
				print will appear here as it settles.
			</Notice>
		);
	}
	const all = model.ranges.find((range) => range.id === 'all');
	if (all === undefined) throw new Error('the chart has no All range');
	const tooltips = Object.fromEntries(
		all.points.map((point) => [point.date, <TooltipBody key={point.date} point={point} />]),
	);
	return (
		<section aria-label='Daily ADI chart' className='mb-12'>
			<IndexChartPlot
				ranges={model.ranges}
				initial={model.initial}
				hero={
					model.headline === null ? (
						<NoValueHero suspended={all.bands.length > 0} />
					) : (
						<Hero headline={model.headline} />
					)
				}
				tooltips={tooltips}
			/>
			<Legend />
			<FinalsNote finalCount={model.finalCount} />
			<div className='sr-only'>
				<Table
					caption='Every point in the chart, oldest first'
					head={['Date (UTC)', 'Status', 'ADI', 'ADI-GS', 'Coverage']}
					rows={all.points.map((point) => [
						point.date,
						point.status === 'provisional' ? 'today so far, provisional' : point.status,
						point.status === 'suspended' ? 'no value' : formatInteger(point.value),
						point.status === 'suspended' ? 'no value' : formatInteger(point.groundStopValue),
						formatPercent(point.coveragePercent),
					])}
				/>
			</div>
		</section>
	);
}

function Hero({ headline }: { headline: Headline }) {
	const { latest, previousFinal } = headline;
	const running = latest.status === 'provisional';
	const label = running ? 'ADI, running' : 'ADI, latest print';
	return (
		<div role='group' aria-label={label}>
			<p className='text-ink-subtle text-xs tracking-wide uppercase'>
				{running ? 'ADI today so far' : `ADI, ${latest.status} print`}
			</p>
			<p className='text-ink-muted mt-1 text-sm'>
				<UtcDay date={latest.date}>{latest.date} (UTC)</UtcDay>
			</p>
			<p className='mt-1 text-6xl font-semibold tracking-tight [font-feature-settings:normal] sm:text-7xl'>
				{formatInteger(latest.value)}
			</p>
			<p className='text-ink-muted mt-2 text-sm'>
				airport-minutes,{' '}
				{running ? (
					<StatusLabel tone='neutral'>provisional until the day settles</StatusLabel>
				) : (
					<StatusLabel tone={SETTLED_TONE[latest.status]}>{latest.status} print</StatusLabel>
				)}
			</p>
			<p className='text-ink-muted mt-1 text-sm'>
				{previousFinal === null ? (
					'No earlier final print to compare with yet.'
				) : (
					<>
						<span className='text-ink font-medium'>
							{formatSigned(latest.value - previousFinal.value)}
						</span>{' '}
						vs the final print for {previousFinal.date} ({formatInteger(previousFinal.value)})
						{running ? ', a part day against a whole one' : ''}
					</>
				)}
			</p>
		</div>
	);
}

/** No day in the chart has a value: said plainly, in the headline's place. */
function NoValueHero({ suspended }: { suspended: boolean }) {
	return (
		<div role='group' aria-label='ADI, no value'>
			<p className='text-ink-subtle text-xs tracking-wide uppercase'>ADI</p>
			<p className='text-ink-muted mt-1 text-4xl font-semibold tracking-tight'>No value yet</p>
			<p className='text-ink-muted mt-2 max-w-md text-sm'>
				{suspended ? 'Every settled day so far is suspended, ' : 'No day has settled yet, '}
				and today has no valid round, so there is no number to show. The chart below shows every
				print that exists.
			</p>
		</div>
	);
}

function TooltipBody({ point }: { point: ChartPoint }) {
	const coverage = `coverage ${formatPercent(point.coveragePercent)}`;
	return (
		<div className='space-y-1'>
			<p className='font-medium'>
				<UtcDay date={point.date}>
					{point.status === 'provisional' ? `Today, ${point.date} (UTC)` : `${point.date} (UTC)`}
				</UtcDay>
			</p>
			{point.status === 'suspended' ? (
				<p>
					<StatusLabel tone='bad'>Suspended</StatusLabel>: no value, {coverage}
				</p>
			) : (
				<>
					<p>
						<strong className='text-base'>{formatInteger(point.value)}</strong> ADI
						<span className='text-ink-muted'>
							{' '}
							· {formatInteger(point.groundStopValue)} ADI-GS (ground stops only)
						</span>
					</p>
					{point.status === 'provisional' ? (
						<p className='text-ink-muted'>
							<StatusLabel tone='neutral'>Provisional</StatusLabel>, so far today, as of{' '}
							<Instant at={point.asOf} />
						</p>
					) : (
						<p className='text-ink-muted'>
							<StatusLabel tone={SETTLED_TONE[point.status]}>{point.status}</StatusLabel>,{' '}
							{coverage}
						</p>
					)}
				</>
			)}
		</div>
	);
}

function LegendKey({ status }: { status: MarkStatus }) {
	return (
		<svg aria-hidden viewBox='0 0 28 14' className='h-3.5 w-7 shrink-0'>
			<line
				x1={0}
				x2={28}
				y1={7}
				y2={7}
				className='stroke-series-adi'
				strokeWidth={2}
				strokeDasharray={status === 'provisional' ? PROVISIONAL_DASH : undefined}
			/>
			<Mark status={status} x={14} y={7} />
		</svg>
	);
}

const LEGEND: readonly { key: ReactNode; label: string }[] = [
	{ key: <LegendKey status='final' />, label: 'Final print' },
	{ key: <LegendKey status='degraded' />, label: 'Degraded print (partial coverage)' },
	{ key: <LegendKey status='provisional' />, label: 'Today so far, provisional' },
	{
		key: (
			<svg aria-hidden viewBox='0 0 12 14' className='h-3.5 w-3 shrink-0'>
				<defs>
					<SuspendedHatch id='adi-legend-suspended' />
				</defs>
				<rect
					x={0.5}
					y={0.5}
					width={11}
					height={13}
					fill='url(#adi-legend-suspended)'
					className='stroke-ink-subtle'
					strokeWidth={1}
				/>
			</svg>
		),
		label: 'Suspended: hatched, no value, a gap in the line',
	},
	{
		key: <span aria-hidden className='border-line block h-3.5 w-3 shrink-0 border border-dashed' />,
		label: 'No print: left blank',
	},
];

function Legend() {
	return (
		<ul className='text-ink-muted mt-4 flex flex-wrap gap-x-6 gap-y-2 text-xs'>
			{LEGEND.map((item) => (
				<li key={item.label} className='flex items-center gap-2'>
					{item.key}
					{item.label}
				</li>
			))}
		</ul>
	);
}

/** With fewer than two final prints there is no trend to read, and the chart says so. */
function FinalsNote({ finalCount }: { finalCount: number }) {
	if (finalCount >= 2) return null;
	return (
		<p className='text-ink-muted mt-4 max-w-2xl text-sm'>
			{finalCount === 0
				? 'No day has settled final yet.'
				: 'Only one day has settled final so far.'}{' '}
			The chart shows every print that exists and nothing else: no padding, no interpolation. A
			trend needs more settled days.
		</p>
	);
}
