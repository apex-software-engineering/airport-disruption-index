import { Notice } from '@/components/ui';
import type { MisfiledIndicative } from '@/server/indicative-archive';

/**
 * Said beside the indicative series when stored indicative objects could not be read: the days
 * shown are not all of them, and the reported objects are named in the API, never hidden.
 */
export function IndicativeIncomplete({ misfiled }: { misfiled: MisfiledIndicative | undefined }) {
	if (misfiled === undefined) return null;
	const count = misfiled.objects.length;
	return (
		<div className='mb-4'>
			<Notice>
				{count === 1 ? 'One stored indicative day' : `${count} stored indicative days`} could not be
				read and {count === 1 ? 'is' : 'are'} not shown. The objects are listed as{' '}
				<code>misfiled_indicative</code> at{' '}
				<a href='/api/v1/indicative/history'>/api/v1/indicative/history</a>.
			</Notice>
		</div>
	);
}
