const repoUrl = 'https://github.com/apex-software-engineering/airport-disruption-index';

export const site = {
	name: 'Airport Disruption Index',
	description:
		'A settlement-grade index of FAA ground stops and ground delay programs at US airports.',
	footer: 'An Apex Software Engineering index',
	repoUrl,
	/** Where incidents and corrections are discussed: issues labelled `incident`. */
	incidentIssuesUrl: `${repoUrl}/issues?q=label%3Aincident`,
} as const;

/** The shell commands that get the source onto a machine, shown before every reproduce command. */
export const cloneCommand = `git clone ${site.repoUrl} && cd airport-disruption-index && npm ci`;

const CONTACT_PLACEHOLDER = 'TODO(Alex)';

/** The operator's published contact address. Replace the placeholder once it is decided. */
export const CONTACT_EMAIL: string = CONTACT_PLACEHOLDER;

/** The address to publish, or null while it is still the placeholder, which is never shown. */
export const contactEmail: string | null =
	CONTACT_EMAIL === CONTACT_PLACEHOLDER ? null : CONTACT_EMAIL;
