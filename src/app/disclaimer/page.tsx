import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';

export const metadata: Metadata = { title: 'Disclaimer' };

export default function DisclaimerPage() {
	return <DocBody name='disclaimer' now={new Date()} />;
}
