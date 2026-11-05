export const about = {
  name: 'Aura',
  version: '1.0.0',
  author: 'IamZach',
  credit: 'built by IamZach',
  supportName: 'Astra Gaming Network (AGN)',
  supportUrl: 'https://discord.gg/agn',
  repoUrl: 'https://github.com/1amZach/aura-standalone',
  status: '/help · discord.gg/agn',
};

export const footerText = () => `Aura v${about.version} · ${about.credit} · support at discord.gg/agn`;

export class CreditsError extends Error {
  constructor() {
    super(
      'Aura won’t start because its credits were changed. The license requires the original credit to IamZach and the AGN support link (discord.gg/agn) to stay in place. Put them back, or grab a fresh copy from ' +
        about.repoUrl,
    );
    this.name = 'CreditsError';
  }
}
