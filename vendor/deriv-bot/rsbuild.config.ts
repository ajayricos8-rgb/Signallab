import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { pluginSass } from '@rsbuild/plugin-sass';
import path from 'node:path';

// The upstream app is built as a same-origin sub-application. The trailing
// slash matters for Blockly media, SmartCharts chunks, and React Router.
const base = `/${(process.env.BASE_PATH || '/').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
const dbotBase = `${base}/dbot/`;

export default defineConfig({
    plugins: [pluginSass({ exclude: /node_modules/ }), pluginReact()],
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
        },
    },
    output: {
        assetPrefix: dbotBase,
        cleanDistPath: true,
        distPath: { root: path.resolve(__dirname, '../../artifacts/deriv-signal-lab/public/dbot') },
        copy: [
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/*', to: 'js/smartcharts/[name][ext]', globOptions: { ignore: ['**/*.LICENSE.txt'] } },
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/*', to: 'assets/[name][ext]' },
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/fonts/*', to: 'assets/fonts/[name][ext]' },
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/shaders/*', to: 'assets/shaders/[name][ext]' },
            { from: 'node_modules/@deriv-com/smartcharts-champion/dist/assets/packages', to: 'assets/packages' },
            { from: path.join(__dirname, 'public') },
        ],
    },
    html: { template: './index.html' },
    tools: {
        rspack: { module: { rules: [{ test: /\.xml$/, exclude: /node_modules/, use: 'raw-loader' }] } },
    },
});
