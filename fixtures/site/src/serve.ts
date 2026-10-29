import { startFixtureSite } from './index.ts';

const site = await startFixtureSite();
console.log(`shop:        ${site.url}`);
console.log(`sgtm host:   ${site.sgtmUrl}`);
console.log(`third party: ${site.thirdPartyUrl}`);
console.log('Press Ctrl+C to stop.');
process.on('SIGINT', () => void site.close().then(() => process.exit(0)));
