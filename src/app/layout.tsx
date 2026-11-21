import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { footerLinks, site } from '@/lib/site';

import './globals.css';

export const metadata: Metadata = {
	title: { default: site.name, template: `%s · ${site.name}` },
	description: site.description,
};

const NAV = [
	{ href: '/methodology', label: 'Methodology' },
	{ href: '/docs/api', label: 'API' },
	{ href: '/sources', label: 'Sources' },
	{ href: '/status', label: 'Status' },
] as const;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
	return (
		<html lang='en'>
			<body className='bg-page text-ink flex min-h-dvh flex-col antialiased'>
				<header className='border-line border-b'>
					<nav className='mx-auto flex max-w-4xl flex-wrap items-baseline gap-x-6 gap-y-2 px-6 py-4 text-sm'>
						<Link href='/' className='text-ink mr-auto font-semibold no-underline'>
							{site.name}
						</Link>
						{NAV.map((item) => (
							<Link
								key={item.href}
								href={item.href}
								className='text-ink-muted no-underline hover:underline'>
								{item.label}
							</Link>
						))}
					</nav>
				</header>
				<main className='mx-auto w-full max-w-4xl flex-1 px-6 py-10'>{children}</main>
				<footer className='border-line text-ink-subtle border-t text-sm'>
					<p className='mx-auto max-w-4xl px-6 py-4'>
						{site.footer}
						{footerLinks.map((link) => (
							<span key={link.href}>
								{' · '}
								<a href={link.href}>{link.label}</a>
							</span>
						))}
					</p>
				</footer>
			</body>
		</html>
	);
}
