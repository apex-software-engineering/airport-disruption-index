import type { Metadata } from 'next';

import { DocBody } from '@/components/doc-body';

export const metadata: Metadata = { title: 'Independence policy' };

export default function IndependencePage() {
	return <DocBody name='independence' />;
}
