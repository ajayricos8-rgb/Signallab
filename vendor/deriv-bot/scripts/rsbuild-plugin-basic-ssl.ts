import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import type { RsbuildPlugin } from '@rsbuild/core';

/**
 * Local replacement for @rsbuild/plugin-basic-ssl.
 *
 * The 1.x plugin depends on selfsigned 3, which pulls in node-forge (a known
 * vulnerability with no patched release). selfsigned 5 drops node-forge, but its
 * generate() is async, so the 1.x plugin can't use it. This keeps the same
 * behaviour: a self-signed localhost certificate for the dev server, reused for
 * 30 days.
 */
const CERT_VALID_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CERT_PATH = path.resolve(__dirname, '../node_modules/.cache/basic-ssl/fake-cert.pem');

const getCertificate = async (): Promise<string> => {
    if (fs.existsSync(CERT_PATH)) {
        const ageDays = (Date.now() - fs.statSync(CERT_PATH).mtimeMs) / DAY_MS;
        if (ageDays < CERT_VALID_DAYS) return fs.promises.readFile(CERT_PATH, 'utf-8');
    }

    const pem = await selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
        algorithm: 'sha256',
        notAfterDate: new Date(Date.now() + CERT_VALID_DAYS * DAY_MS),
    });
    const content = pem.private + pem.cert;

    await fs.promises.mkdir(path.dirname(CERT_PATH), { recursive: true });
    await fs.promises.writeFile(CERT_PATH, content, 'utf-8');
    return content;
};

export const pluginBasicSsl = (): RsbuildPlugin => ({
    name: 'local:basic-ssl',
    setup(api) {
        api.modifyRsbuildConfig(async config => {
            const https = config.server?.https;
            if (https && typeof https === 'object' && https.key && https.cert) return;

            const content = await getCertificate();
            config.server = { ...config.server, https: { key: content, cert: content } };
        });
    },
});
