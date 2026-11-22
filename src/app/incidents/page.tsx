import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';
import { Facts, Instant, Mono, Notice, Section, UtcDay } from '@/components/ui';
import { site } from '@/lib/site';
import { storeFromEnv } from '@/server/storage';
import { correctionsView, type CorrectionEntry } from '@/server/views';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Incidents' };

/** The operator's log is docs/incidents.md; the correction prints are read from the archive. */
export default async function IncidentsPage() {
	const corrections = await correctionsView(storeFromEnv());
	return (
		<>
			<DocBody name='incidents' />
			<Section id='correction-prints' title='Correction prints'>
				<p className='text-ink-muted mb-4 text-sm'>
					Every revision after the first of any day, read from the published prints, most recently
					issued first. Each supersedes the print named, which stays published.
				</p>
				{corrections.length === 0 ? (
					<Notice>No correction print has been issued.</Notice>
				) : (
					<ol className='space-y-8'>
						{corrections.map((entry) => (
							<li key={entry.printHash}>
								<CorrectionFacts entry={entry} />
							</li>
						))}
					</ol>
				)}
			</Section>
			<Section id='discussion' title='Discussion'>
				<p className='text-sm'>
					Each incident and correction is discussed in an{' '}
					<a href={site.incidentIssuesUrl}>issue labelled incident</a> in the public repository.
				</p>
			</Section>
		</>
	);
}

function CorrectionFacts({ entry }: { entry: CorrectionEntry }) {
	return (
		<Facts
			rows={[
				{ term: 'Day (UTC)', detail: <UtcDay date={entry.date} /> },
				{ term: 'Revision', detail: String(entry.revision) },
				{ term: 'Issued', detail: <Instant at={entry.issuedAt} /> },
				{ term: 'Reason', detail: entry.reason },
				...(entry.windowOverride === null
					? []
					: [{ term: 'Issued after the window', detail: entry.windowOverride }]),
				{ term: 'Supersedes', detail: <Mono>{entry.supersedesPrintHash}</Mono> },
				{ term: 'Print hash', detail: <Mono>{entry.printHash}</Mono> },
				{ term: 'Print', detail: <a href={entry.url}>{entry.url}</a> },
			]}
		/>
	);
}
