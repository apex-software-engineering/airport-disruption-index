/** Small presentational pieces shared by the public pages. */
import type { ReactNode } from 'react';

import { addDays, dayStartMs, type UtcDate } from '@/lib/index/time';

import { formatUtc } from './format';
import { LocalTime } from './local-time';

export function PageTitle({ title, lede }: { title: string; lede?: ReactNode }) {
	return (
		<header className='mb-8'>
			<h1 className='text-2xl font-semibold tracking-tight'>{title}</h1>
			{lede === undefined ? null : <p className='text-ink-muted mt-2 max-w-2xl'>{lede}</p>}
		</header>
	);
}

export function Section({
	id,
	title,
	children,
}: {
	id?: string;
	title: ReactNode;
	children: ReactNode;
}) {
	return (
		<section id={id} className='mt-12 first:mt-0'>
			<h2 className='mb-4 text-lg font-semibold'>{title}</h2>
			{children}
		</section>
	);
}

/** A labelled figure. `value` is already formatted; `note` explains it in a line. */
export function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<div role='group' aria-label={label} className='border-line border-l-2 pl-4'>
			<p className='text-ink-subtle text-xs tracking-wide uppercase'>{label}</p>
			<p className='mt-1 font-mono text-3xl font-semibold tabular-nums'>{value}</p>
			{note === undefined ? null : <p className='text-ink-muted mt-1 text-sm'>{note}</p>}
		</div>
	);
}

/** Key/value rows, for receipts-like facts (ids, hashes, times). */
export function Facts({ rows }: { rows: readonly { term: string; detail: ReactNode }[] }) {
	return (
		<dl className='grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]'>
			{rows.map((row) => (
				<div key={row.term} className='contents'>
					<dt className='text-ink-subtle'>{row.term}</dt>
					<dd className='min-w-0 break-words'>{row.detail}</dd>
				</div>
			))}
		</dl>
	);
}

/** A UTC instant, the canonical value, with the viewer's local time beside it. */
export function Instant({ at }: { at: string }) {
	return (
		<>
			<time dateTime={at}>{formatUtc(at)}</time>
			<LocalTime at={at} />
		</>
	);
}

/**
 * A UTC calendar day, labelled by `children` (the date by default), with the stretch of the
 * viewer's local time it covers on a line below.
 */
export function UtcDay({ date, children = date }: { date: UtcDate; children?: ReactNode }) {
	const start = new Date(dayStartMs(date)).toISOString();
	const end = new Date(dayStartMs(addDays(date, 1))).toISOString();
	return (
		<>
			<time dateTime={date}>{children}</time>
			<LocalTime at={start} until={end} line />
		</>
	);
}

export function Mono({ children }: { children: ReactNode }) {
	return <code className='font-mono text-[0.85em] break-words'>{children}</code>;
}

/** Stated plainly in a box; used where there is no data to show yet. */
export function Notice({ children }: { children: ReactNode }) {
	return (
		<div className='border-line bg-panel text-ink-muted rounded border px-4 py-3 text-sm'>
			{children}
		</div>
	);
}

export function Table({
	head,
	rows,
	caption,
}: {
	head: readonly string[];
	rows: readonly (readonly ReactNode[])[];
	caption?: string;
}) {
	return (
		<div className='overflow-x-auto'>
			<table className='w-full border-collapse text-sm'>
				{caption === undefined ? null : <caption className='sr-only'>{caption}</caption>}
				<thead>
					<tr className='border-line border-b'>
						{head.map((cell, index) => (
							<th
								key={cell}
								scope='col'
								className={`text-ink-subtle py-2 pr-4 font-medium ${index === 0 ? 'text-left' : 'text-right'}`}>
								{cell}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, rowIndex) => (
						<tr key={rowIndex} className='border-line border-b last:border-b-0'>
							{row.map((cell, index) => (
								<td
									key={index}
									className={`py-2 pr-4 ${index === 0 ? 'text-left' : 'text-right font-mono tabular-nums'}`}>
									{cell}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const TONES = {
	good: 'text-good',
	warn: 'text-warn',
	bad: 'text-bad',
	neutral: 'text-ink-muted',
} as const;

/** A state named in words, with colour only as a second cue. */
export function StatusLabel({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
	return <span className={`font-medium ${TONES[tone]}`}>{children}</span>;
}
