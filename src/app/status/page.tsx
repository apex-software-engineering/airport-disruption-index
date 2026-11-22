import type { Metadata } from 'next';

import { describeCoverage } from '@/components/coverage';
import { formatInteger, formatPercent } from '@/components/format';
import {
	hasValidRound,
	type Current,
	readLastReceipt,
	readSiteData,
	RECENT_PRINT_DAYS,
	SETTLED_TONE,
} from '@/components/index-data';
import {
	Facts,
	Instant,
	Mono,
	Notice,
	PageTitle,
	Section,
	StatusLabel,
	UtcDay,
} from '@/components/ui';
import type { RoundReceipt } from '@/lib/index/schemas';
import { roundUrl } from '@/server/views';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Status' };

export default async function StatusPage() {
	const now = new Date();
	const { current, recent } = await readSiteData(now);
	const receipt = await readLastReceipt(current);
	const coverage = describeCoverage(current.coverage);
	const lastPrint = recent[0];

	return (
		<>
			<PageTitle
				title='Status'
				lede={
					<>
						As of <Instant at={current.asOf} punctuation='.' />
					</>
				}
			/>

			<Section title='Last round'>
				{receipt === null ? (
					<Notice>No round has been recorded for {current.date} (UTC) yet.</Notice>
				) : (
					<LastRound receipt={receipt} />
				)}
			</Section>

			<Section title={<UtcDay date={current.date}>Today, {current.date} (UTC)</UtcDay>}>
				{current.foreignMethodologies.length > 0 && (
					<Notice>
						Some of today&apos;s rounds were collected under another methodology (
						{current.foreignMethodologies
							.map((m) => `${formatInteger(m.rounds)} under v${m.methodologyVersion}`)
							.join(', ')}
						). They are not counted, and the day will print suspended.
					</Notice>
				)}
				<Facts
					rows={[
						{
							term: 'Status',
							detail: <StatusLabel tone='neutral'>{current.status}</StatusLabel>,
						},
						{ term: 'Settles at', detail: <Instant at={current.settlesAt} /> },
						{ term: 'Print due by', detail: <Instant at={current.publishBy} /> },
						{
							term: 'Unrecognized lists',
							detail:
								current.unrecognizedLists.length === 0 ? (
									'none seen today'
								) : (
									<UnrecognizedLists lists={current.unrecognizedLists} />
								),
						},
						{
							term: 'Coverage',
							detail: `${coverage.percent} of the day (${coverage.observed})`,
						},
						{ term: 'Slots', detail: coverage.slots },
						{ term: 'Ended', detail: coverage.ended },
						{
							term: 'Running value',
							detail: hasValidRound(current)
								? `ADI ${formatInteger(current.value)}, ADI-GS ${formatInteger(current.groundStopValue)} airport-minutes`
								: 'none yet (no valid round today)',
						},
						{
							term: 'Methodology',
							detail: (
								<>
									v{current.methodologyVersion}, parameter hash <Mono>{current.parameterHash}</Mono>
								</>
							),
						},
					]}
				/>
			</Section>

			<Section title='Last settlement print'>
				{lastPrint === undefined ? (
					<Notice>No day has settled in the last {RECENT_PRINT_DAYS} days.</Notice>
				) : (
					<Facts
						rows={[
							{ term: 'Date (UTC)', detail: <UtcDay date={lastPrint.date} /> },
							{
								term: 'Status',
								detail: (
									<StatusLabel tone={SETTLED_TONE[lastPrint.status]}>
										{lastPrint.status}
									</StatusLabel>
								),
							},
							{
								term: 'Value',
								detail:
									lastPrint.value === null || lastPrint.groundStopValue === null
										? 'none (suspended)'
										: `ADI ${formatInteger(lastPrint.value)}, ADI-GS ${formatInteger(lastPrint.groundStopValue)} airport-minutes`,
							},
							{ term: 'Coverage', detail: formatPercent(lastPrint.coveragePercent) },
							{ term: 'Revision', detail: String(lastPrint.revision) },
							{ term: 'Print hash', detail: <Mono>{lastPrint.printHash}</Mono> },
							{ term: 'Print', detail: <a href={lastPrint.url}>{lastPrint.url}</a> },
						]}
					/>
				)}
			</Section>
		</>
	);
}

/** Feed lists v1 does not know: never counted, flagged so a reshaped feed is seen at once. */
function UnrecognizedLists({ lists }: { lists: Current['unrecognizedLists'] }) {
	return (
		<>
			<StatusLabel tone='warn'>flagged</StatusLabel> not counted by v1:{' '}
			{lists.map((list, i) => (
				<span key={`${list.element} ${list.name}`}>
					{i > 0 && '; '}
					<Mono>{list.element ?? '(no list element)'}</Mono>
					{list.name !== null && ` (“${list.name}”)`} in {formatInteger(list.rounds)} round
					{list.rounds === 1 ? '' : 's'}, last{' '}
					<a href={roundUrl(list.lastRoundId)}>{list.lastRoundId}</a>
				</span>
			))}
		</>
	);
}

/** Every fact here comes from the one receipt read, so they cannot disagree. */
function LastRound({ receipt }: { receipt: RoundReceipt }) {
	const url = roundUrl(receipt.roundId);
	const { observation } = receipt;
	return (
		<Facts
			rows={[
				{ term: 'Round id', detail: <Mono>{receipt.roundId}</Mono> },
				{ term: 'Fetched', detail: <Instant at={receipt.fetchedAt} /> },
				{
					term: 'Validity',
					detail:
						observation.status === 'valid' ? (
							<StatusLabel tone='good'>valid</StatusLabel>
						) : (
							<>
								<StatusLabel tone='bad'>invalid</StatusLabel> ({observation.reason})
							</>
						),
				},
				{ term: 'Receipt hash', detail: <Mono>{receipt.receiptHash}</Mono> },
				{
					term: 'Receipt',
					detail: (
						<>
							<a href={url}>{url}</a>
							{receipt.rawSha256 === null ? (
								' (no source body was received)'
							) : (
								<>
									{' '}
									(<a href={`${url}/raw`}>raw source body</a>)
								</>
							)}
						</>
					),
				},
			]}
		/>
	);
}
