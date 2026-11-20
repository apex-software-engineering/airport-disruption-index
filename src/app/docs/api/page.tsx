import type { Metadata } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { readLastReceipt, readSiteData } from '@/components/index-data';
import { Mono, Notice, PageTitle, Section } from '@/components/ui';
import { GET as getMethodology } from '@/app/api/v1/methodology/route';
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
	const rawSha256 = receipt === null ? null : receipt.rawSha256;

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
				coverage so far, the latest slot&apos;s state and the last round with its receipt URL.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/history?from=YYYY-MM-DD&to=YYYY-MM-DD`}
				cache={CACHE.daily}
				curl={`curl -s '${origin}${API_BASE}/history?from=${history.from}&to=${history.to}'`}
				sample={history}>
				Settled days in a date range, oldest first: status, value, GS-only value, coverage and print
				hash, each with its print URL. Defaults to the 30 days ending yesterday; at most 366 days.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/days/{date}`}
				cache={`${CACHE.daily} (settled); ${CACHE.live} with HTTP 404 until then`}
				curl={`curl -s ${origin}${API_BASE}/days/${sampleDate}`}
				sample={day}>
				A day&apos;s settlement print, the latest revision first in <Mono>print</Mono> and every
				revision in <Mono>revisions</Mono>. Before the cutoff the response is 404 with{' '}
				<Mono>status: &quot;unsettled&quot;</Mono> and <Mono>settlesAt</Mono>.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/rounds/{id}`}
				cache={`${CACHE.immutable} once the receipt is final; ${CACHE.none} before`}
				curl={`curl -s ${origin}${roundPath}`}
				sample={receipt}>
				The receipt for one round. The id is the slot start in UTC at minute precision, e.g.{' '}
				<Mono>2026-11-17T20:45Z</Mono>. It records the fetch, the HTTP status, the sha256 of the raw
				body, the parsed observation and the receipt hash. A valid receipt is final when written; an
				invalid one becomes final 60 seconds after its slot ends.
			</Endpoint>

			<Endpoint
				path={`${API_BASE}/rounds/{id}/raw`}
				cache={`${CACHE.immutable} once the receipt is final; ${CACHE.none} before`}
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
				print carries.
			</Endpoint>

			<Section id='reproduce' title='Reproducing a number'>
				<p className='text-ink-muted mb-4 max-w-2xl'>
					The reproduce script fetches a receipt and its raw body from this API, checks both hashes,
					re-parses the body with the same calculation code and compares every field. For a day it
					does that for every round in the print, then rebuilds the print. From a checkout of the
					index source, with Node 24:
				</p>
				<Code>
					{[
						'npm ci',
						`npm run reproduce -- ${sampleRoundId} --base-url ${origin}`,
						`npm run reproduce -- ${sampleDate} --base-url ${origin}`,
					].join('\n')}
				</Code>
				<p className='text-ink-muted mt-4 max-w-2xl'>
					It prints <Mono>MATCH</Mono> or <Mono>MISMATCH</Mono>. Exit code 0 is a match, 1 a
					mismatch, 2 could not verify. Details are in the{' '}
					<a href='/methodology#reproducing'>methodology</a>.
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
