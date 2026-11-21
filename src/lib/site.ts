export const site = {
	name: 'Airport Disruption Index',
	description:
		'A settlement-grade index of FAA ground stops and ground delay programs at US airports.',
	footer: 'An Apex Software Engineering index',
	repoUrl: 'https://github.com/apex-software-engineering/airport-disruption-index',
	/** The credit CC BY 4.0 asks for when the index values, prints or receipts are reused. */
	dataAttribution: 'Airport Disruption Index by Apex Software Engineering LLC',
} as const;

/** The footer links, in order, after the attribution. */
export const footerLinks = [
	{ href: '/terms', label: 'Terms' },
	{ href: '/disclaimer', label: 'Disclaimer' },
	{ href: '/independence', label: 'Independence' },
	{ href: site.repoUrl, label: 'Source code' },
] as const;

/** The shell commands that get the source onto a machine, shown before every reproduce command. */
export const cloneCommand = `git clone ${site.repoUrl} && cd airport-disruption-index && npm ci`;
