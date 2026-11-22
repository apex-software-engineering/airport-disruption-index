/**
 * The home chart's point marks, one shape per print status so status never rests on colour alone.
 * Drawn by the chart and by its legend, so the two cannot drift apart. Each carries a 2px ring in
 * the page colour, so it stays legible where it sits on the line.
 */
import type { ChartPoint } from './index-series';

export type MarkStatus = Exclude<ChartPoint['status'], 'suspended'>;

export function Mark({ status, x, y }: { status: MarkStatus; x: number; y: number }) {
	if (status === 'final') {
		return <circle cx={x} cy={y} r={4.5} className='fill-series-adi stroke-page' strokeWidth={2} />;
	}
	if (status === 'degraded') {
		const r = 6;
		return (
			<path
				d={`M${x},${y - r} L${x + r},${y} L${x},${y + r} L${x - r},${y} Z`}
				className='fill-page stroke-series-adi'
				strokeWidth={2}
				strokeLinejoin='round'
			/>
		);
	}
	return <circle cx={x} cy={y} r={4.5} className='fill-page stroke-series-adi' strokeWidth={2} />;
}

/** The dashed stroke that marks a value as provisional. */
export const PROVISIONAL_DASH = '4 4';

/**
 * The fill of a suspended day: muted 45° hairlines over the panel colour, so a suspended day reads
 * apart from a day with no print (left blank) without leaning on a faint tint.
 */
export function SuspendedHatch({ id }: { id: string }) {
	return (
		<pattern
			id={id}
			width={6}
			height={6}
			patternUnits='userSpaceOnUse'
			patternTransform='rotate(45)'>
			<rect width={6} height={6} className='fill-panel' />
			<line x1={0} y1={0} x2={0} y2={6} className='stroke-ink-subtle' strokeWidth={1} />
		</pattern>
	);
}
