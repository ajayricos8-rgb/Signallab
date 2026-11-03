import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';
import path from 'node:path';

// DBot is built as a same-origin sub-application, not as an SPA route fallback.
const base = `/${(process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
const dbotBase = `${base}/dbot/`;

export default defineConfig({
  plugins: [
    pluginSass({
      exclude: /node_modules/,
      sassLoaderOptions: { sassOptions: { loadPaths: [path.resolve(__dirname, './src')] } },
    }),
    pluginReact(),
  ],
  source: {
    entry: { index: './src/main.tsx' },
    define: {
      'process.env': {
        APP_ENV: JSON.stringify(process.env.DBOT_ENV || 'production'),
        CLIENT_ID: JSON.stringify(process.env.DBOT_OAUTH_CLIENT_ID || ''),
        APP_ID: JSON.stringify(process.env.DBOT_APP_ID || process.env.VITE_DERIV_APP_ID || '1089'),
        DBOT_BASE_PATH: JSON.stringify(dbotBase),
        GD_CLIENT_ID: JSON.stringify(process.env.GD_CLIENT_ID || ''),
        GD_APP_ID: JSON.stringify(process.env.GD_APP_ID || ''),
        GD_API_KEY: JSON.stringify(process.env.GD_API_KEY || ''),
        TRANSLATIONS_CDN_URL: JSON.stringify(process.env.TRANSLATIONS_CDN_URL || ''),
        R2_PROJECT_NAME: JSON.stringify(process.env.R2_PROJECT_NAME || ''),
        CROWDIN_BRANCH_NAME: JSON.stringify(process.env.CROWDIN_BRANCH_NAME || ''),
        TRACKJS_TOKEN: JSON.stringify(process.env.TRACKJS_TOKEN || ''),
        REF_NAME: JSON.stringify(process.env.REF_NAME || ''),
        REMOTE_CONFIG_URL: JSON.stringify(process.env.REMOTE_CONFIG_URL || ''),
        RUDDERSTACK_KEY: JSON.stringify(process.env.RUDDERSTACK_KEY || ''),
        GROWTHBOOK_CLIENT_KEY: JSON.stringify(process.env.GROWTHBOOK_CLIENT_KEY || ''),
        GROWTHBOOK_DECRYPTION_KEY: JSON.stringify(process.env.GROWTHBOOK_DECRYPTION_KEY || ''),
      },
    },
    alias: {
      react: path.resolve('./node_modules/react'),
      'react-dom': path.resolve('./node_modules/react-dom'),
      '@/external': path.resolve(__dirname, './src/external'),
      '@/components': path.resolve(__dirname, './src/components'),
      '@/hooks': path.resolve(__dirname, './src/hooks'),
      '@/utils': path.resolve(__dirname, './src/utils'),
      '@/constants': path.resolve(__dirname, './src/constants'),
      '@/stores': path.resolve(__dirname, './src/stores'),
      '@/services': path.resolve(__dirname, './src/services'),
      '@/analytics': path.resolve(__dirname, './src/analytics'),
      '@/pages': path.resolve(__dirname, './src/pages'),
      '@/pages': path.resolve(__dirname, './src/pages'),
      '@/analytics': path.resolve(__dirname, './src/analytics'),
    },
  },
  output: {
    assetPrefix: dbotBase,
    cleanDistPath: true,
    distPath: { root: path.resolve(__dirname, '../../artifacts/deriv-signal-lab/public/dbot') },
    copy: [
      { from: 'node_modules/@deriv/deriv-charts/dist/*', to: 'js/smartcharts/[name][ext]', globOptions: { ignore: ['**/*.LICENSE.txt'] } },
      { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/*', to: 'assets/[name][ext]' },
      { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/fonts/*', to: 'assets/fonts/[name][ext]' },
      { from: 'node_modules/@deriv/deriv-charts/dist/chart/assets/shaders/*', to: 'assets/shaders/[name][ext]' },
      { from: path.join(__dirname, 'public') },
    ],
  },
  html: { template: './index.html' },
  tools: {
    rspack: { module: { rules: [{ test: /\.xml$/, exclude: /node_modules/, use: 'raw-loader' }] } },
  },
});
