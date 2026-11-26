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
				<strong>Methodology v{version} is announced.</strong> It is set to take effect at{' '}
				<Instant at={effectiveAt(upcoming).toISOString()} punctuation=',' /> if this notice’s public
				readback and its timestamp proof are recorded at least 30 days before, and the follow-up
				registry change is deployed before then; otherwise v{current} continues. From{' '}
				{upcoming.effectiveFrom} each settlement day would be the {zone} day; days up to{' '}
				{addDays(upcoming.effectiveFrom, -1)} stay under v{current} and its rules. Read the{' '}
				<a href='/incidents'>notice</a> and the{' '}
				<a href='/methodology#settlement-rules'>v{version} rules</a>. Until then the ADI (ET,
				indicative) series shows the new days, never as settlement values.
			</Notice>
		</div>
	);
}
