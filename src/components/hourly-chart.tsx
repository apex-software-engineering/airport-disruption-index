/**
 * The day's hourly series as one stacked bar per UTC hour: ground-stop minutes at the base and
 * GDP-only minutes above them, so each bar's height is the headline value for that hour and its
 * lower segment is the GS-only sub-index. Plain SVG, rendered on the server in UTC; the browser
 * adds the viewer's local time under the axis labels and to each hour's native tooltip. The same
 * numbers are in the table below the chart.
 */
import type { HourBucket } from '@/lib/index/schemas';

import { niceCeiling, ticksTo } from './chart-scale';
import { formatInteger, formatUtcHour } from './format';
import { LocalHour, LocalTime, LocalTimeTitle } from './local-time';
import { Table } from './ui';

const WIDTH = 720;
const HEIGHT = 234;
/** The bottom margin holds two axis lines: the UTC hour, and the viewer's local time under it. */
const PLOT = { left: 44, right: 8, top: 8, bottom: 38 } as const;
const GAP = 2;
const RADIUS = 4;

type Bar = {
	hour: HourBucket;
	label: string;
	groundStop: number;
	gdpOnly: number;
	/** No slot of this hour has ended yet. */
	upcoming: boolean;
};

function barsOf(hourly: readonly HourBucket[]): Bar[] {
	return hourly.map((hour) => {
		const gdpOnly = hour.airportMinutes - hour.groundStopMinutes;
		if (gdpOnly < 0) {
			throw new Error(`hour ${hour.hourStart}: GS minutes exceed headline minutes`);
		}
		const ended = hour.observed + hour.carried + hour.missing;
		return {
			hour,
			label: formatUtcHour(hour.hourStart),
			groundStop: hour.groundStopMinutes,
			gdpOnly,
			upcoming: ended === 0,
		};
	});
}

/** A bar segment with rounded top corners only (the data end), flat on the baseline side. */
function segmentPath(x: number, y: number, width: number, height: number, rounded: boolean) {
	const r = rounded ? Math.min(RADIUS, width / 2, height) : 0;
	return [
		`M${x},${y + height}`,
		`V${y + r}`,
		r > 0 ? `Q${x},${y} ${x + r},${y}` : '',
		`H${x + width - r}`,
		r > 0 ? `Q${x + width},${y} ${x + width},${y + r}` : '',
		`V${y + height}`,
		'Z',
	].join(' ');
}

/** A native tooltip: the hour in UTC with the viewer's local time, then its numbers. */
function Tooltip({ bar }: { bar: Bar }) {
	const { hour } = bar;
	const lines = bar.upcoming
		? ['not yet ended']
		: [
				`ADI ${formatInteger(hour.airportMinutes)} airport-minutes`,
				`ADI-GS ${formatInteger(hour.groundStopMinutes)}`,
				`slots: ${hour.observed} observed, ${hour.carried} carried, ${hour.missing} missing, ${hour.pending} pending`,
			];
	return (
		<LocalTimeTitle
			at={hour.hourStart}
			before={`${bar.label} UTC`}
			after={`\n${lines.join('\n')}`}
		/>
	);
}

export function HourlyChart({ hourly }: { hourly: readonly HourBucket[] }) {
	const bars = barsOf(hourly);
	const top = niceCeiling(Math.max(...bars.map((b) => b.groundStop + b.gdpOnly)));
	const plotWidth = WIDTH - PLOT.left - PLOT.right;
	const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
	const slotWidth = plotWidth / bars.length;
	const barWidth = slotWidth - GAP;
	const yOf = (minutes: number) => PLOT.top + plotHeight * (1 - minutes / top);
	const ticks = ticksTo(top);

	return (
		<figure>
			<div className='text-ink-muted mb-3 flex flex-wrap gap-x-6 gap-y-1 text-sm'>
				<span className='flex items-center gap-2'>
					<span aria-hidden className='bg-series-gs inline-block size-3 rounded-sm' />
					Ground stop
				</span>
				<span className='flex items-center gap-2'>
					<span aria-hidden className='bg-series-gdp inline-block size-3 rounded-sm' />
					Ground delay program only
				</span>
			</div>
			<svg
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				className='h-auto w-full'
				role='img'
				aria-label='Airport-minutes per UTC hour today, split into ground stop and GDP-only minutes'>
				{ticks.map((tick) => (
					<g key={tick}>
						<line
							x1={PLOT.left}
							x2={WIDTH - PLOT.right}
							y1={yOf(tick)}
							y2={yOf(tick)}
							className='stroke-line'
							strokeWidth={1}
						/>
						<text
							x={PLOT.left - 6}
							y={yOf(tick)}
							textAnchor='end'
							dominantBaseline='middle'
							className='fill-ink-subtle text-[11px]'>
							{formatInteger(tick)}
						</text>
					</g>
				))}
				{bars.map((bar, index) => {
					const x = PLOT.left + index * slotWidth + GAP / 2;
					const gsTop = yOf(bar.groundStop);
					const total = bar.groundStop + bar.gdpOnly;
					const totalTop = yOf(total);
					return (
						<g key={bar.hour.hourStart}>
							<Tooltip bar={bar} />
							<rect
								x={x}
								y={PLOT.top}
								width={barWidth}
								height={plotHeight}
								className={bar.upcoming ? 'fill-panel' : 'fill-transparent'}
							/>
							{bar.groundStop > 0 ? (
								<path
									d={segmentPath(x, gsTop, barWidth, yOf(0) - gsTop, bar.gdpOnly === 0)}
									className='fill-series-gs'
								/>
							) : null}
							{bar.gdpOnly > 0 ? (
								<path
									d={segmentPath(x, totalTop, barWidth, gsTop - totalTop, true)}
									className='fill-series-gdp'
								/>
							) : null}
							{index % 3 === 0 ? (
								<>
									<text
										x={x + barWidth / 2}
										y={HEIGHT - 22}
										textAnchor='middle'
										className='fill-ink-subtle text-[11px]'>
										{bar.label}
									</text>
									<text
										x={x + barWidth / 2}
										y={HEIGHT - 8}
										textAnchor='middle'
										className='noscript:hidden fill-ink-subtle text-[10px]'>
										<LocalHour at={bar.hour.hourStart} />
									</text>
								</>
							) : null}
						</g>
					);
				})}
			</svg>
			<figcaption className='text-ink-subtle mt-2 text-xs'>
				Airport-minutes per UTC hour
				<span className='noscript:hidden'>, with your local time under each UTC hour</span>. Shaded
				hours have not ended yet.
			</figcaption>
			<details className='mt-4 text-sm'>
				<summary className='text-ink-muted cursor-pointer'>Hourly table</summary>
				<div className='mt-3'>
					<Table
						caption='Airport-minutes and slot coverage per UTC hour'
						head={['Hour (UTC)', 'ADI', 'ADI-GS', 'Observed', 'Carried', 'Missing', 'Pending']}
						rows={bars.map((bar) => [
							// A fixed width for the local line, so filling it cannot resize the column.
							<div key='hour' className='w-44'>
								<time dateTime={bar.hour.hourStart}>{bar.label}</time>
								<LocalTime at={bar.hour.hourStart} />
							</div>,
							formatInteger(bar.hour.airportMinutes),
							formatInteger(bar.hour.groundStopMinutes),
							bar.hour.observed,
							bar.hour.carried,
							bar.hour.missing,
							bar.hour.pending,
						])}
					/>
				</div>
			</details>
		</figure>
	);
}
