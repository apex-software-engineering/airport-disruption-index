/**
 * Source adapters: how the FAA feed is fetched and parsed into the observation the methodology
 * measures. An adapter fix (a new address or shape for the same FAA data) is a new entry here,
 * not a methodology release: the methodology version and parameter hash stay the same, and each
 * receipt records the adapter that produced it so it is always rebuilt with that one.
 */
import { parseFeed, type FeedParseResult } from './feed';

export type FeedAdapter = {
	readonly version: string;
	/** The address fetched. Each receipt records it as `sourceUrl`. */
	readonly url: string;
	readonly parse: (text: string) => FeedParseResult;
};

const FAA_FEED_URL = 'https://nasstatus.faa.gov/api/airport-status-information';

/** Every adapter, oldest first. An entry is never edited or removed once a receipt cites it. */
const ADAPTERS: readonly FeedAdapter[] = [
	{
		version: 'faa-nas-xml/1',
		url: FAA_FEED_URL,
		parse: (xml) => parseFeed(xml, 'unchecked'),
	},
	/**
	 * Fails closed (`unrecognized_structure`) on a root element the feed has never carried, or a
	 * counted-program block that does not hold exactly its list.
	 */
	{
		version: 'faa-nas-xml/2',
		url: FAA_FEED_URL,
		parse: (xml) => parseFeed(xml, 'checked'),
	},
];

/** Receipts that predate the `adapterVersion` field were all produced by the first adapter. */
const UNRECORDED_ADAPTER = 'faa-nas-xml/1';

/** The adapter new rounds are collected with: the newest one. */
export const CURRENT_ADAPTER: FeedAdapter = newest(ADAPTERS);

/**
 * The adapter a receipt records (`undefined` for a receipt written before the field existed),
 * or null when this code does not know it.
 */
export function adapterOf(recorded: string | undefined): FeedAdapter | null {
	const version = recorded ?? UNRECORDED_ADAPTER;
	return ADAPTERS.find((adapter) => adapter.version === version) ?? null;
}

function newest(adapters: readonly FeedAdapter[]): FeedAdapter {
	const adapter = adapters.at(-1);
	if (adapter === undefined) throw new Error('no feed adapter is registered');
	return adapter;
}
