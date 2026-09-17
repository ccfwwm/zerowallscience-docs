import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  site: 'https://zerowallscience.org',
  integrations: [react(), tailwind()],
  i18n: {
    defaultLocale: 'zh',
    locales: ['en', 'zh'],
    routing: { prefixDefaultLocale: false },
  },
  output: 'static',
});
