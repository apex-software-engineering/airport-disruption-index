import { Instant, Notice } from '@/components/ui';
import { collectingRelease, effectiveAt, upcomingRelease } from '@/lib/index/calendar';
import { addDays } from '@/lib/index/time';

/**
 * During a notice period (design §5), the release that takes effect next, where its notice and
 * rules are, and the indicative series that shows its days meanwhile. Nothing outside one.
 */
export function UpcomingNotice({ now }: { now: Date }) {
	const upcoming = upcomingRelease(now);
	if (upcoming === null) return null;
	const current = collectingRelease(now).parameters.version;
	const { version, day } = upcoming.parameters;
	const zone = day === 'utc' ? 'UTC' : `${day.timeZone} (US Eastern)`;
	return (
		<div className='mb-8'>
			<Notice>
				<strong>Methodology v{version} is announced.</strong> It takes effect at{' '}
				<Instant at={effectiveAt(upcoming).toISOString()} punctuation=',' /> and from{' '}
				{upcoming.effectiveFrom} each settlement day is the {zone} day. Days up to{' '}
				{addDays(upcoming.effectiveFrom, -1)} stay under v{current} and its rules. Read the{' '}
				<a href='/incidents'>notice</a> and the{' '}
				<a href='/methodology#settlement-rules'>v{version} rules</a>. Until then the ADI (ET,
				indicative) series shows the new days, never as settlement values.
			</Notice>
		</div>
	);
}
