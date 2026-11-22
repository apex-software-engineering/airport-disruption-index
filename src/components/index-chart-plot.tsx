'use client';
/**
 * The interactive half of the home chart: the range buttons, the line itself and its tooltip. The
 * server builds every range (`index-series.ts`) and renders every tooltip body, so this file only
 * draws and responds. The plot is drawn at its measured size, so text and marks stay at their
 * real pixel sizes on a phone; before it is measured it renders at a default size, scaled to fit.
 */
import {
	useEffect,
	useId,
	useRef,
	useState,
	type FocusEvent,
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
} from 'react';

import { Mark, PROVISIONAL_DASH } from './chart-marks';
import { niceCeiling, ticksTo } from './chart-scale';
import { formatInteger, formatShortDate } from './format';
import type { ChartPoint, RangeId, RangeView } from './index-series';

const DEFAULT_SIZE = { width: 720, height: 340 };
const PLOT = { left: 48, right: 16, top: 36, bottom: 28 } as const;
/**
 * From this width the newest value is labelled in a right margin of its own, where nothing else
 * is drawn, so the label can never sit on the line. Narrower, the headline above carries it.
 */
const END_LABEL_MIN_WIDTH = 480;
const END_LABEL_ROOM = 72;
/** The least room an x-axis date label gets, so labels never collide. */
const MIN_TICK_GAP = 72;
/** Half the width of each point's hit and focus target. */
const HIT_RADIUS = 12;
const TOOLTIP_WIDTH = 300;
/** Space between the crosshair and the tooltip. */
const TOOLTIP_OFFSET = 14;

/** The tooltip's left edge: beside the point, on the side with room, never past either edge. */
function tooltipLeft(x: number, chartWidth: number, tooltipWidth: number): number {
	return x > chartWidth / 2
		? Math.max(0, x - TOOLTIP_OFFSET - tooltipWidth)
		: Math.min(x + TOOLTIP_OFFSET, chartWidth - tooltipWidth);
}

function pointLabel(point: ChartPoint): string {
	if (point.status === 'suspended') return `${point.date} UTC: suspended, no value`;
	const status = point.status === 'provisional' ? 'today so far, provisional' : point.status;
	return `${point.date} UTC: ${status}, ADI ${formatInteger(point.value)}, ADI-GS ${formatInteger(point.groundStopValue)}`;
}

/** The newest point always gets a label, then every `step`-th point back from it. */
function tickPoints(points: readonly ChartPoint[], plotWidth: number): ChartPoint[] {
	const room = Math.max(1, Math.floor(plotWidth / MIN_TICK_GAP));
	const step = Math.ceil(points.length / room);
	return points.filter((_, index) => (points.length - 1 - index) % step === 0);
}

function useMeasuredSize<T extends Element>() {
	const ref = useRef<T>(null);
	const [size, setSize] = useState(DEFAULT_SIZE);
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry === undefined) return;
			const { width, height } = entry.contentRect;
			if (width > 0 && height > 0) {
				setSize({ width: Math.round(width), height: Math.round(height) });
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { ref, size };
}

export function IndexChartPlot({
	ranges,
	initial,
	hero,
	tooltips,
}: {
	ranges: readonly RangeView[];
	initial: RangeId;
	/** The headline value, rendered on the server, beside the range buttons. */
	hero: ReactNode;
	/** Each point's tooltip body, rendered on the server, by date. */
	tooltips: Readonly<Record<string, ReactNode>>;
}) {
	const [selected, setSelected] = useState(initial);
	const [active, setActive] = useState<number | null>(null);
	const { ref, size } = useMeasuredSize<HTMLDivElement>();
	const pointRefs = useRef<(SVGGElement | null)[]>([]);
	const summaryId = useId();
	const disabledId = useId();

	const range = ranges.find((candidate) => candidate.id === selected);
	if (range === undefined) throw new Error(`no range ${selected}`);
	const { points, lines } = range;

	const { width, height } = size;
	const newest = points.at(-1);
	const endLabelled =
		width >= END_LABEL_MIN_WIDTH && newest !== undefined && newest.status !== 'suspended'
			? newest
			: null;
	const right = endLabelled === null ? PLOT.right : END_LABEL_ROOM;
	const plotWidth = width - PLOT.left - right;
	const plotHeight = height - PLOT.top - PLOT.bottom;
	const span = range.lastDay - range.firstDay + 1;
	const slot = plotWidth / span;
	const xOf = (day: number) => PLOT.left + (day - range.firstDay + 0.5) * slot;
	const values = points.flatMap((point) => (point.status === 'suspended' ? [] : [point.value]));
	const top = niceCeiling(Math.max(0, ...values));
	const yOf = (value: number) => PLOT.top + plotHeight * (1 - value / top);
	const baseline = yOf(0);

	const choose = (id: RangeId) => {
		setSelected(id);
		setActive(null);
	};

	const nearest = (event: PointerEvent<SVGRectElement>): number | null => {
		const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
		if (box === undefined || box.width === 0) return null;
		const x = ((event.clientX - box.left) * width) / box.width;
		const distance = (index: number) => Math.abs(xOf(points[index]?.day ?? Infinity) - x);
		return points.reduce<number | null>(
			(best, _, index) => (best === null || distance(index) < distance(best) ? index : best),
			null,
		);
	};

	const onKeyDown = (event: KeyboardEvent<SVGGElement>, index: number) => {
		const next = {
			ArrowLeft: index - 1,
			ArrowRight: index + 1,
			Home: 0,
			End: points.length - 1,
		}[event.key];
		if (event.key === 'Escape') {
			setActive(null);
			return;
		}
		if (next === undefined || next < 0 || next >= points.length) return;
		event.preventDefault();
		pointRefs.current[next]?.focus();
	};

	const onBlur = (event: FocusEvent<SVGGElement>) => {
		const to = event.relatedTarget;
		if (!pointRefs.current.some((element) => element !== null && element === to)) setActive(null);
	};

	const focusIndex = active ?? points.length - 1;
	const activePoint = active === null ? undefined : points[active];
	const disabled = ranges.filter((candidate) => candidate.disabledReason !== null);
	const tooltipWidth = Math.min(TOOLTIP_WIDTH, width);

	return (
		<figure>
			<div className='flex flex-wrap items-start justify-between gap-x-6 gap-y-4'>
				{hero}
				<div
					role='group'
					aria-label='Chart range'
					className='border-line inline-flex rounded border p-0.5 text-xs font-medium'>
					{ranges.map((candidate) => {
						const off = candidate.disabledReason !== null;
						return (
							<button
								key={candidate.id}
								type='button'
								aria-pressed={candidate.id === selected}
								aria-disabled={off}
								aria-describedby={off ? disabledId : undefined}
								title={candidate.disabledReason ?? undefined}
								onClick={() => (off ? undefined : choose(candidate.id))}
								className={`min-w-11 rounded-sm px-3 py-1.5 ${
									candidate.id === selected
										? 'bg-ink text-page'
										: off
											? 'text-ink-subtle cursor-not-allowed opacity-50'
											: 'text-ink-muted hover:bg-panel'
								}`}>
								{candidate.label}
							</button>
						);
					})}
				</div>
			</div>
			<p id={summaryId} className='sr-only'>
				{range.summary}
			</p>
			<div ref={ref} className='relative mt-6 h-64 sm:h-[22rem]'>
				<svg
					viewBox={`0 0 ${width} ${height}`}
					className='block h-full w-full'
					role='group'
					aria-label={`Line chart of the daily ADI, range ${range.label}`}
					aria-describedby={summaryId}>
					{ticksTo(top).map((tick) => (
						<g key={tick} aria-hidden>
							<line
								x1={PLOT.left}
								x2={width - right}
								y1={yOf(tick)}
								y2={yOf(tick)}
								className={tick === 0 ? 'stroke-ink-subtle' : 'stroke-line'}
								strokeWidth={1}
							/>
							<text
								x={PLOT.left - 8}
								y={yOf(tick)}
								textAnchor='end'
								dominantBaseline='middle'
								className='fill-ink-subtle text-[11px]'>
								{formatInteger(tick)}
							</text>
						</g>
					))}
					{tickPoints(points, plotWidth).map((point) => (
						<text
							key={point.date}
							aria-hidden
							x={xOf(point.day)}
							y={height - 8}
							textAnchor='middle'
							className='fill-ink-subtle text-[11px]'>
							{formatShortDate(point.date)}
						</text>
					))}
					{points.map((point, index) =>
						point.status === 'suspended' ? (
							<rect
								key={point.date}
								aria-hidden
								x={xOf(point.day) - Math.max(slot - 2, 4) / 2}
								y={PLOT.top}
								width={Math.max(slot - 2, 4)}
								height={plotHeight}
								className={active === index ? 'fill-line' : 'fill-panel'}
							/>
						) : null,
					)}
					{activePoint === undefined ? null : (
						<line
							aria-hidden
							x1={xOf(activePoint.day)}
							x2={xOf(activePoint.day)}
							y1={PLOT.top}
							y2={baseline}
							className='stroke-ink-subtle'
							strokeWidth={1}
						/>
					)}
					{lines.runs.map((run) => (
						<polyline
							key={run[0]?.date}
							aria-hidden
							points={run.map((point) => `${xOf(point.day)},${yOf(point.value)}`).join(' ')}
							fill='none'
							className='stroke-series-adi'
							strokeWidth={2}
							strokeLinejoin='round'
							strokeLinecap='round'
						/>
					))}
					{lines.provisionalLink === null ? null : (
						<line
							aria-hidden
							x1={xOf(lines.provisionalLink[0].day)}
							y1={yOf(lines.provisionalLink[0].value)}
							x2={xOf(lines.provisionalLink[1].day)}
							y2={yOf(lines.provisionalLink[1].value)}
							className='stroke-series-adi'
							strokeWidth={2}
							strokeDasharray={PROVISIONAL_DASH}
							strokeLinecap='round'
						/>
					)}
					{points.map((point, index) => {
						const x = xOf(point.day);
						const y = point.status === 'suspended' ? baseline - plotHeight / 2 : yOf(point.value);
						return (
							<g
								key={point.date}
								ref={(element) => {
									pointRefs.current[index] = element;
								}}
								role='img'
								aria-label={pointLabel(point)}
								tabIndex={index === focusIndex ? 0 : -1}
								onFocus={() => setActive(index)}
								onBlur={onBlur}
								onKeyDown={(event) => onKeyDown(event, index)}
								className='pointer-events-none outline-none'>
								<circle cx={x} cy={y} r={HIT_RADIUS} className='fill-transparent' />
								{active === index ? (
									<circle cx={x} cy={y} r={9} className='stroke-ink fill-none' strokeWidth={1.5} />
								) : null}
								{point.status === 'suspended' ? null : <Mark status={point.status} x={x} y={y} />}
							</g>
						);
					})}
					{endLabelled === null ? null : (
						<text
							aria-hidden
							x={xOf(endLabelled.day) + 12}
							y={yOf(endLabelled.value)}
							dominantBaseline='middle'
							className='fill-ink text-[12px] font-medium'>
							{formatInteger(endLabelled.value)}
							{endLabelled.status === 'provisional' ? (
								<tspan
									x={xOf(endLabelled.day) + 12}
									dy='1.2em'
									className='fill-ink-subtle font-normal'>
									so far
								</tspan>
							) : null}
						</text>
					)}
					<rect
						x={PLOT.left}
						y={0}
						width={plotWidth}
						height={height}
						className='fill-transparent'
						style={{ touchAction: 'pan-y' }}
						onPointerMove={(event) => {
							if (event.pointerType === 'mouse') setActive(nearest(event));
						}}
						onPointerDown={(event) => setActive(nearest(event))}
						onPointerLeave={(event) => {
							if (event.pointerType === 'mouse') setActive(null);
						}}
					/>
				</svg>
				{activePoint === undefined ? null : (
					<div
						data-chart-tooltip
						aria-hidden
						className='border-line bg-page pointer-events-none absolute z-10 rounded border px-3 py-2 text-sm shadow-sm'
						style={{
							width: tooltipWidth,
							left: tooltipLeft(xOf(activePoint.day), width, tooltipWidth),
							// Above the plot, unless the point is in its upper half: then below it.
							...(activePoint.status !== 'suspended' &&
							yOf(activePoint.value) < PLOT.top + plotHeight / 2
								? { bottom: PLOT.bottom + 4 }
								: { top: 0 }),
						}}>
						{tooltips[activePoint.date]}
					</div>
				)}
			</div>
			<figcaption className='text-ink-subtle mt-3 space-y-1 text-xs'>
				<p>
					Daily ADI in airport-minutes, one point per settled UTC day
					<span className='noscript:hidden'>
						; hover, tap or focus a point (arrow keys move) for its date in your local time
					</span>
					.
				</p>
				{disabled.length === 0 ? null : (
					<p id={disabledId}>
						{disabled.map((candidate) => candidate.label).join(' and ')}{' '}
						{disabled.length === 1 ? 'is' : 'are'} off until more days settle: each would show the
						same prints as the next range up.
					</p>
				)}
				<p>
					Source, the public API:{' '}
					{range.sources.map((source, index) => (
						<span key={source}>
							{index > 0 ? ' and ' : ''}
							<a href={source} className='break-all'>
								{source}
							</a>
						</span>
					))}
				</p>
			</figcaption>
		</figure>
	);
}
