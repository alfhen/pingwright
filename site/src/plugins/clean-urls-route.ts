import { defineRouteMiddleware } from '@astrojs/starlight/route-data';
import { cleanRouteUrls } from './clean-urls.ts';

export const onRequest = defineRouteMiddleware(({ locals, site }) => {
  cleanRouteUrls(locals.starlightRoute, site);
});
