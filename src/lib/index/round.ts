/**
 * One round = one poll of the feed. A round is evaluated purely from what was fetched (HTTP
 * status, body bytes, fetch time), so anyone holding the archived body can rebuild the receipt.
 */
import { hashJson, sha256Hex } from './json';
import { methodologyOf, type Methodology } from './methodology';
import { adapterOf, type FeedAdapter } from './adapters';
import type {
	AirportState,
	Observation,
	ProgramEvent,
	RoundReceipt,
	RoundSummary,
} from './schemas';
import { roundIdFor, slotStartMs } from './time';

export type FetchOutcome =
	| { kind: 'response'; httpStatus: number; body: Uint8Array }
	| { kind: 'network_error'; detail: string };

export const RECEIPT_SCHEMA = 'adi.round-receipt/1' as const;

export function evaluateObservation(
	fetchedAt: Date,
	outcome: FetchOutcome,
	methodology: Methodology,
	adapter: FeedAdapter,
): Observation {
	if (outcome.kind === 'network_error') {
		return invalid('network_error', outcome.detail, null);
	}
	const { requireHttpStatus, maxFeedAgeSeconds, maxFeedLeadSeconds } =
		methodology.parameters.observation;
	if (outcome.httpStatus !== requireHttpStatus) {
		return invalid('http_status', `HTTP ${outcome.httpStatus}`, null);
	}
	const text = decodeUtf8(outcome.body);
	if (text === null) return invalid('parse_error', 'body is not valid UTF-8', null);
	const parsed = adapter.parse(text);
	if (!parsed.ok) return invalid(parsed.reason, parsed.detail, null);
	const { updateTime, events, otherDelayTypes } = parsed.feed;
	const ageSeconds = (fetchedAt.getTime() - Date.parse(updateTime)) / 1000;
	if (ageSeconds > maxFeedAgeSeconds) {
		return invalid(
			'stale_feed',
			`Update_Time is ${ageSeconds}s old (limit ${maxFeedAgeSeconds}s)`,
			updateTime,
		);
	}
	if (-ageSeconds > maxFeedLeadSeconds) {
		return invalid(
			'feed_ahead_of_clock',
			`Update_Time is ${-ageSeconds}s after fetch (limit ${maxFeedLeadSeconds}s)`,
			updateTime,
		);
	}
	return {
		status: 'valid',
		feedUpdateTime: updateTime,
		events,
		otherDelayTypes,
		panel: panelState(events, methodology.parameters.panel),
	};
}

function invalid(
	reason: Extract<Observation, { status: 'invalid' }>['reason'],
	detail: string,
	feedUpdateTime: string | null,
): Observation {
	return { status: 'invalid', reason, detail, feedUpdateTime };
}

function decodeUtf8(body: Uint8Array): string | null {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		return null;
	}
}

/** Per panel airport, whether any event of each program names it. */
export function panelState(
	events: readonly ProgramEvent[],
	panel: readonly string[],
): AirportState[] {
	return panel.map((airport) => ({
		airport,
		groundStop: events.some((e) => e.program === 'ground_stop' && e.airport === airport),
		groundDelayProgram: events.some(
			(e) => e.program === 'ground_delay_program' && e.airport === airport,
		),
	}));
}

/**
 * The receipt for one round, evaluated under `methodology` (see methodologyFor) and parsed by
 * the adapter `adapterVersion` names. `adapterVersion` is undefined only when rebuilding a
 * receipt written before receipts recorded it; the rebuilt receipt then omits it too.
 */
export function buildReceipt(input: {
	fetchedAt: Date;
	sourceUrl: string;
	outcome: FetchOutcome;
	methodology: Methodology;
	adapterVersion: string | undefined;
}): RoundReceipt {
	const { fetchedAt, sourceUrl, outcome, methodology, adapterVersion } = input;
	const adapter = adapterOf(adapterVersion);
	if (adapter === null) throw new Error(`unknown feed adapter ${adapterVersion}`);
	const body = outcome.kind === 'response' ? outcome.body : null;
	const unsigned: Omit<RoundReceipt, 'receiptHash'> = {
		schema: RECEIPT_SCHEMA,
		roundId: roundIdFor(fetchedAt),
		slotStart: new Date(slotStartMs(fetchedAt)).toISOString(),
		fetchedAt: fetchedAt.toISOString(),
		sourceUrl,
		...(adapterVersion === undefined ? {} : { adapterVersion }),
		methodologyVersion: methodology.parameters.version,
		parameterHash: methodology.parameterHash,
		httpStatus: outcome.kind === 'response' ? outcome.httpStatus : null,
		rawSha256: body === null ? null : sha256Hex(body),
		rawBytes: body === null ? null : body.byteLength,
		observation: evaluateObservation(fetchedAt, outcome, methodology, adapter),
	};
	return { ...unsigned, receiptHash: hashJson(unsigned) };
}

/** The release a receipt records. Stored receipts are schema-checked to record a known one. */
export function recordedMethodology(receipt: RoundReceipt): Methodology {
	const methodology = methodologyOf(receipt.methodologyVersion, receipt.parameterHash);
	if (methodology === null)
		throw new Error(
			`round ${receipt.roundId} records unknown methodology ${receipt.methodologyVersion}`,
		);
	return methodology;
}

export function receiptHashMatches(receipt: RoundReceipt): boolean {
	const { receiptHash, ...unsigned } = receipt;
	return hashJson(unsigned) === receiptHash;
}

/**
 * The fetch outcome a receipt records, given the archived body. A network error has no body,
 * so its recorded detail is the outcome.
 */
export function outcomeFromReceipt(receipt: RoundReceipt, body: Uint8Array | null): FetchOutcome {
	if (receipt.httpStatus === null) {
		if (receipt.observation.status !== 'invalid') {
			throw new Error(`round ${receipt.roundId} is valid without an HTTP response`);
		}
		return { kind: 'network_error', detail: receipt.observation.detail };
	}
	if (body === null)
		throw new Error(`round ${receipt.roundId} has an HTTP response but no archived body`);
	return { kind: 'response', httpStatus: receipt.httpStatus, body };
}

export function summarizeReceipt(receipt: RoundReceipt): RoundSummary {
	const { observation } = receipt;
	return {
		roundId: receipt.roundId,
		fetchedAt: receipt.fetchedAt,
		receiptHash: receipt.receiptHash,
		methodologyVersion: receipt.methodologyVersion,
		parameterHash: receipt.parameterHash,
		observation:
			observation.status === 'valid'
				? {
						status: 'valid',
						feedUpdateTime: observation.feedUpdateTime,
						active: observation.panel.filter((row) => row.groundStop || row.groundDelayProgram),
						unrecognized: observation.otherDelayTypes
							.filter((list) => list.disposition === 'unrecognized')
							.map(({ name, element }) => ({ name, element })),
					}
				: { status: 'invalid', reason: observation.reason },
	};
}
