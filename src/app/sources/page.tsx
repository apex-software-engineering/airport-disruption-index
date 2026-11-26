import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';

export const metadata: Metadata = { title: 'Sources' };

export default function SourcesPage() {
	return <DocBody name='sources' now={new Date()} />;
}
