import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { RECENT_PRINT_DAYS, readLastReceipt, readSiteData } from '@/components/index-data';
import { Mono, Notice, PageTitle, Section } from '@/components/ui';
import { GET as getMethodology } from '@/app/api/v1/methodology/route';
import { cloneCommand, site } from '@/lib/site';
import { CACHE } from '@/server/http';
import { storeFromEnv } from '@/server/storage';
import { API_BASE, dayView } from '@/server/views';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'API' };

const SAMPLE_ARRAY_ITEMS = 2;

/** Long arrays cut to their first items plus a marker, so a sample stays readable. */
function abbreviate(value: unknown): unknown {
	if (Array.isArray(value)) {
		const kept = value.slice(0, SAMPLE_ARRAY_ITEMS).map(abbreviate);
		const dropped = value.length - kept.length;
		return dropped > 0 ? [...kept, `… ${dropped} more`] : kept;
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, abbreviate(v)]));
	}
	return value;
}

/** The origin this page was served from, so the examples work against this deployment. */
async function requestOrigin(): Promise<string> {
	const headerList = await headers();
	const host = headerList.get('x-forwarded-host') ?? headerList.get('host');
	if (host === null) throw new Error('request has no host header');
	const proto = headerList.get('x-forwarded-proto') ?? 'https';
	return `${proto}://${host}`;
}

export default async function ApiDocsPage() {
	const origin = await requestOrigin();
	const { current, history, recent } = await readSiteData(new Date());
	const sampleDate = recent[0]?.date ?? history.to;
	const [day, receipt] = await Promise.all([
		dayView(storeFromEnv(), sampleDate),
		readLastReceipt(current),
	]);
	// The route's own response, so the sample cannot drift from what the endpoint serves.
	const methodology: unknown = await getMethodology().json();
	const sampleRoundId = current.lastRound?.roundId ?? '{id}';
	const roundPath = `${API_BASE}/rounds/${sampleRoundId}`;
	// Only a valid receipt is immutable, so only its body hash is a stable example.
	const rawSha256 =
		receipt !== null && receipt.observation.status === 'valid' ? receipt.rawSha256 : null;

	// An example is shown only when it names something that exists, so every pasted command works.
	const reproduceCommands: string[] = [];
	const reproduceNotes: string[] = [];
	if (receipt === null) {
		reproduceNotes.push('No round has been recorded today yet, so there is no round to reproduce.');
	} else {
		reproduceCommands.push(`npm run reproduce -- ${sampleRoundId} --base-url ${origin}`);
	}
	if (day.status === 'settled') {
		reproduceCommands.push(`npm run reproduce -- ${sampleDate} --base-url ${origin}`);
	} else {
		reproduceNotes.push(
			`No settled print is available in the last ${RECENT_PRINT_DAYS} days, so there is no print to reproduce.`,
		);
	}

	return (
		<>
			<PageTitle
				title='API'
				lede={
					<>
						Public, read-only JSON over HTTPS. No key, CORS open to any origin. Every time is UTC.
						Base URL <Mono>{origin}</Mono>. The samples below are live responses from this
						deployment, with long arrays shortened.
					</>
				}
			/>

			<Endpoint
				path={`${API_BASE}/current`}
				cache={CACHE.live}
				curl={`curl -s ${origin}${API_BASE}/current`}
				sample={current}>
				Today&apos;s running (provisional) value: ADI and ADI-GS, per-airport and hourly series,
				coverage so far, the latest slot&apos;s state and the last round with its receipt URL.{' '}
				<Mono>publishBy</Mono> is the publication deadline for today&apos;s print.{' '}
				<Mono>unrecognizedLists</Mono> names any feed list v1 does not know that today&apos;s valid
				rounds carried (never counted), and <Mono>foreignMethodologies</Mono> any rounds under
				another methodology (the day will print suspended).
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/history?from=YYYY-MM-DD&to=YYYY-MM-DD`}
				cache={CACHE.live}
				curl={`curl -s '${origin}${API_BASE}/history?from=${history.from}&to=${history.to}'`}
				sample={history}>
				Settled days in a date range, oldest first: status, value, GS-only value, coverage and print
				hash, each with its print URL. Defaults to the 30 days ending yesterday; at most 366 days.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/days/{date}`}
				cache={`${CACHE.live}, with HTTP 404 until the day settles`}
				curl={`curl -s ${origin}${API_BASE}/days/${sampleDate}`}
				sample={day}>
				A day&apos;s settlement print, the latest revision first in <Mono>print</Mono> and every
				revision in <Mono>revisions</Mono>. Before the cutoff the response is 404 with{' '}
				<Mono>status: &quot;unsettled&quot;</Mono>, <Mono>settlesAt</Mono> and{' '}
				<Mono>publishBy</Mono>.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/rounds/{id}`}
				cache={`${CACHE.immutable} for a valid receipt; ${CACHE.none} for an invalid one`}
				curl={`curl -s ${origin}${roundPath}`}
				sample={receipt}>
				The receipt for one round. The id is the slot start in UTC at minute precision, e.g.{' '}
				<Mono>2026-11-17T20:45Z</Mono>. It records the fetch, the HTTP status, the sha256 of the raw
				body, the parsed observation and the receipt hash. A valid receipt is never replaced; an
				invalid one stands only until a valid round in the same slot replaces it.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/rounds/{id}/raw`}
				cache={`${CACHE.immutable} for a valid receipt; ${CACHE.none} for an invalid one`}
				curl={
					rawSha256 === null
						? `curl -fsS -o raw.xml ${origin}${API_BASE}/rounds/{id}/raw`
						: `curl -fsS -o raw.xml ${origin}${roundPath}/raw && shasum -a 256 raw.xml`
				}
				sample={null}
				sampleNote={
					rawSha256 === null
						? 'The source response body byte for byte (XML for HTTP 200). A round that received no response has no body and returns 404.'
						: `The source response body byte for byte. For ${sampleRoundId} the hash must print ${rawSha256}, the receipt’s rawSha256.`
				}>
				The FAA feed body exactly as the collector received it. Served sandboxed, with{' '}
				<Mono>X-Content-Type-Options: nosniff</Mono>.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/methodology`}
				cache={CACHE.daily}
				curl={`curl -s ${origin}${API_BASE}/methodology`}
				sample={methodology}>
				The methodology parameters in force, their version and the parameter hash every receipt and
				print carries. <Mono>parameters.source</Mono> is the source as of the release;{' '}
				<Mono>activeAdapter</Mono> is the source adapter collecting now (version and address), which
				a source-adapter fix can change without a methodology release. <Mono>deployedCommit</Mono>{' '}
				is the commit of the public source this deployment was built from, or <Mono>null</Mono> when
				the build could not tell.
			</Endpoint>

			<Section id='reproduce' title='Reproducing a number'>
				<p className='text-ink-muted mb-4 max-w-2xl'>
					The reproduce script fetches a receipt and its raw body from this API, checks both hashes,
					re-parses the body with the same calculation code and compares every field. For a day it
					does that for every round in the print, then rebuilds the print. With Node 24, clone the
					public source and run:
				</p>
				<Code>{[cloneCommand, ...reproduceCommands].join('\n')}</Code>
				{reproduceNotes.map((note) => (
					<p key={note} className='text-ink-muted mt-4 max-w-2xl'>
						{note}
					</p>
				))}
				<p className='text-ink-muted mt-4 max-w-2xl'>
					It prints <Mono>MATCH</Mono> or <Mono>MISMATCH</Mono>. Exit code 0 is a match, 1 a
					mismatch, 2 could not verify. Details are in the{' '}
					<a href='/methodology#reproducing'>methodology</a>.
				</p>
			</Section>

			<Section id='attestations' title='Checking a print against its attestation'>
				<p className='text-ink-muted mb-4 max-w-2xl'>
					After each day settles, a workflow in the public repo reproduces its print and commits an
					attestation to the{' '}
					<a href={`${site.repoUrl}/tree/attestations`}>
						<Mono>attestations</Mono> branch
					</a>{' '}
					(the print hash, a digest of its receipt hashes, the parameter hash, the methodology
					version and the deployed commit) with an OpenTimestamps proof beside it. For a settled
					date, run from the checkout:
				</p>
				<Code>
					{[
						'git worktree add attestations origin/attestations',
						`npm run verify-attestation -- YYYY-MM-DD --base-url ${origin}`,
					].join('\n')}
				</Code>
				<p className='text-ink-muted mt-4 max-w-2xl'>
					It checks the live print against the attestation, then that the proof reached a Bitcoin
					block in time: before D+2 00:00Z for the day&apos;s first print, and within 48 hours of{' '}
					<Mono>correction.issuedAt</Mono> for a correction. Exit code 0 is a match, 1 a mismatch or
					invalid proof, 2 could not verify, 3 no attestation for the current print, 4 a proof still
					pending. Every API response names the deployed commit in its{' '}
					<Mono>X-Deployed-Commit</Mono> header. See the{' '}
					<a href='/methodology#attestations'>methodology</a>.
				</p>
			</Section>
		</>
	);
}

function Endpoint({
	path,
	cache,
	curl,
	sample,
	sampleNote,
	children,
}: {
	path: string;
	cache: string;
	curl: string;
	sample: unknown;
	sampleNote?: string;
	children: ReactNode;
}) {
	return (
		<Section title={`GET ${path}`}>
			<p className='text-ink-muted mb-2 max-w-2xl'>{children}</p>
			<p className='text-ink-subtle mb-4 text-xs'>
				Cache-Control: <Mono>{cache}</Mono>
			</p>
			<Code>{curl}</Code>
			<div className='mt-3'>
				{sampleNote !== undefined ? (
					<Notice>{sampleNote}</Notice>
				) : sample === null ? (
					<Notice>No round has been recorded today, so there is no live sample yet.</Notice>
				) : (
					<Code>{JSON.stringify(abbreviate(sample), null, 2)}</Code>
				)}
			</div>
		</Section>
	);
}

function Code({ children }: { children: string }) {
	return (
		<pre className='border-line bg-panel max-h-96 overflow-auto rounded border px-4 py-3 font-mono text-xs leading-relaxed'>
			<code>{children}</code>
		</pre>
	);
}
