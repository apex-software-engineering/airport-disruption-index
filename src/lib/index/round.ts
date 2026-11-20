/**
 * One round = one poll of the feed. A round is evaluated purely from what was fetched (HTTP
 * status, body bytes, fetch time), so anyone holding the archived body can rebuild the receipt.
 */
import { hashJson, sha256Hex } from './json';
import { METHODOLOGY, PANEL, PARAMETER_HASH } from './methodology';
import { parseFeed } from './feed';
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

export function evaluateObservation(fetchedAt: Date, outcome: FetchOutcome): Observation {
	if (outcome.kind === 'network_error') {
		return invalid('network_error', outcome.detail, null);
	}
	const { requireHttpStatus, maxFeedAgeSeconds, maxFeedLeadSeconds } = METHODOLOGY.observation;
	if (outcome.httpStatus !== requireHttpStatus) {
		return invalid('http_status', `HTTP ${outcome.httpStatus}`, null);
	}
	const text = decodeUtf8(outcome.body);
	if (text === null) return invalid('parse_error', 'body is not valid UTF-8', null);
	const parsed = parseFeed(text);
	if (!parsed.ok) return invalid('parse_error', parsed.detail, null);
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
		panel: panelState(events),
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
export function panelState(events: readonly ProgramEvent[]): AirportState[] {
	return PANEL.map((airport) => ({
		airport,
		groundStop: events.some((e) => e.program === 'ground_stop' && e.airport === airport),
		groundDelayProgram: events.some(
			(e) => e.program === 'ground_delay_program' && e.airport === airport,
		),
	}));
}

export function buildReceipt(input: {
	fetchedAt: Date;
	sourceUrl: string;
	outcome: FetchOutcome;
}): RoundReceipt {
	const { fetchedAt, sourceUrl, outcome } = input;
	const body = outcome.kind === 'response' ? outcome.body : null;
	const unsigned: Omit<RoundReceipt, 'receiptHash'> = {
		schema: RECEIPT_SCHEMA,
		roundId: roundIdFor(fetchedAt),
		slotStart: new Date(slotStartMs(fetchedAt)).toISOString(),
		fetchedAt: fetchedAt.toISOString(),
		sourceUrl,
		methodologyVersion: METHODOLOGY.version,
		parameterHash: PARAMETER_HASH,
		httpStatus: outcome.kind === 'response' ? outcome.httpStatus : null,
		rawSha256: body === null ? null : sha256Hex(body),
		rawBytes: body === null ? null : body.byteLength,
		observation: evaluateObservation(fetchedAt, outcome),
	};
	return { ...unsigned, receiptHash: hashJson(unsigned) };
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
					}
				: { status: 'invalid', reason: observation.reason },
	};
}
