import type { Metadata } from 'next';

import { describeCoverage } from '@/components/coverage';
import { formatInteger, formatPercent, formatUtc } from '@/components/format';
import {
	hasValidRound,
	readLastReceipt,
	readSiteData,
	RECENT_PRINT_DAYS,
	SETTLED_TONE,
} from '@/components/index-data';
import { Facts, Mono, Notice, PageTitle, Section, StatusLabel } from '@/components/ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Status' };

export default async function StatusPage() {
	const now = new Date();
	const { current, recent } = await readSiteData(now);
	const { lastRound } = current;
	const receipt = await readLastReceipt(current);
	const coverage = describeCoverage(current.coverage);
	const lastPrint = recent[0];

	return (
		<>
			<PageTitle title='Status' lede={`As of ${formatUtc(current.asOf)}.`} />

			<Section title='Last round'>
				{lastRound === null ? (
					<Notice>No round has been recorded for {current.date} (UTC) yet.</Notice>
				) : (
					<Facts
						rows={[
							{ term: 'Round id', detail: <Mono>{lastRound.roundId}</Mono> },
							{ term: 'Fetched', detail: formatUtc(lastRound.fetchedAt) },
							{
								term: 'Validity',
								detail: (
									<StatusLabel tone={lastRound.status === 'valid' ? 'good' : 'bad'}>
										{lastRound.status}
									</StatusLabel>
								),
							},
							{ term: 'Receipt hash', detail: <Mono>{lastRound.receiptHash}</Mono> },
							{
								term: 'Receipt',
								detail: (
									<>
										<a href={lastRound.url}>{lastRound.url}</a>
										{receipt === null || receipt.rawSha256 === null ? (
											' (no source body was received)'
										) : (
											<>
												{' '}
												(<a href={`${lastRound.url}/raw`}>raw source body</a>)
											</>
										)}
									</>
								),
							},
						]}
					/>
				)}
			</Section>

			<Section title={`Today, ${current.date} (UTC)`}>
				<Facts
					rows={[
						{
							term: 'Status',
							detail: (
								<>
									<StatusLabel tone='neutral'>{current.status}</StatusLabel>, settles at{' '}
									{formatUtc(current.settlesAt)}
								</>
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
							{ term: 'Date (UTC)', detail: lastPrint.date },
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
