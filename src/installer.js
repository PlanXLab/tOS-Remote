'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { runProcess, noopLogger } = require('./util');
const { t } = require('./i18n');

const RCLONE_DOWNLOAD_BASE = 'https://downloads.rclone.org';
const USER_AGENT = 'tos-remote (VS Code extension)';

function rcloneArch() {
    if (process.arch === 'arm64') {
        return 'arm64';
    }
    return process.arch === 'ia32' ? '386' : 'amd64';
}

function httpsGet(url, redirects = 5) {
    return new Promise((resolve, reject) => {
        const request = https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 30000 }, (response) => {
            const { statusCode, headers } = response;
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume();
                if (redirects <= 0) {
                    reject(new Error(t('Too many redirects: {0}', url)));
                    return;
                }
                resolve(httpsGet(new URL(headers.location, url).toString(), redirects - 1));
                return;
            }
            if (statusCode !== 200) {
                response.resume();
                reject(new Error(t('Download failed (HTTP {0}): {1}', statusCode, url)));
                return;
            }
            resolve(response);
        });
        request.on('timeout', () => request.destroy(new Error(t('Request timed out: {0}', url))));
        request.on('error', reject);
    });
}

async function downloadText(url) {
    const response = await httpsGet(url);
    const chunks = [];
    for await (const chunk of response) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** @returns {Promise<string>} 내려받은 파일의 SHA-256 (hex) */
async function downloadFile(url, destination, onProgress) {
    const response = await httpsGet(url);
    const total = Number(response.headers['content-length']) || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destination);
        response.on('data', (chunk) => {
            hash.update(chunk);
            received += chunk.length;
            if (onProgress) {
                onProgress(received, total);
            }
        });
        response.on('error', reject);
        file.on('error', reject);
        file.on('finish', resolve);
        response.pipe(file);
    });
    return hash.digest('hex');
}

async function getLatestRcloneVersion() {
    const text = await downloadText(`${RCLONE_DOWNLOAD_BASE}/version.txt`);
    const match = /rclone (v\d+\.\d+\.\d+)/.exec(text);
    if (!match) {
        throw new Error(t('Could not determine the latest rclone version: {0}', text.trim()));
    }
    return match[1];
}

/**
 * 최신 rclone을 임시 폴더에 내려받아 SHA-256을 검증하고 rclone.exe만 binDir에 설치한다.
 * @returns {Promise<{version: string, exePath: string}>}
 */
async function installRclone(options) {
    const logger = options.logger || noopLogger;
    const report = options.onProgress || (() => {});
    const arch = rcloneArch();

    report(t('Checking the latest version...'));
    const version = await getLatestRcloneVersion();
    const zipName = `rclone-${version}-windows-${arch}.zip`;
    const baseUrl = `${RCLONE_DOWNLOAD_BASE}/${version}`;

    const sums = await downloadText(`${baseUrl}/SHA256SUMS`);
    const sumLine = sums.split(/\r?\n/).find((line) => line.trim().endsWith(`  ${zipName}`));
    const expected = sumLine && /^([0-9a-f]{64})\s/i.exec(sumLine.trim());
    if (!expected) {
        throw new Error(t('{0} was not found in SHA256SUMS.', zipName));
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-remote-rclone-'));
    try {
        const zipPath = path.join(tempDir, zipName);
        logger.info(`Downloading rclone: ${baseUrl}/${zipName}`);
        let lastPercent = -1;
        const actual = await downloadFile(`${baseUrl}/${zipName}`, zipPath, (received, total) => {
            const percent = total ? Math.floor((received / total) * 100) : -1;
            if (percent !== lastPercent && percent % 5 === 0) {
                lastPercent = percent;
                report(t('Downloading {0}... {1}%', version, percent));
            }
        });
        if (actual.toLowerCase() !== expected[1].toLowerCase()) {
            throw new Error(t('rclone file verification failed (SHA-256 mismatch). Please try again.'));
        }

        report(t('Extracting...'));
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        const result = await runProcess(fs.existsSync(tar) ? tar : 'tar.exe', ['-xf', zipPath, '-C', tempDir], { timeoutMs: 120000 });
        const extracted = path.join(tempDir, `rclone-${version}-windows-${arch}`, 'rclone.exe');
        if (result.code !== 0 || !fs.existsSync(extracted)) {
            throw new Error(t('Extraction failed: {0}', result.stderr.trim() || `exit ${result.code}`));
        }

        fs.mkdirSync(options.binDir, { recursive: true });
        const exePath = path.join(options.binDir, 'rclone.exe');
        const staged = `${exePath}.new`;
        fs.copyFileSync(extracted, staged);
        try {
            fs.renameSync(staged, exePath);
        } catch (error) {
            fs.rmSync(staged, { force: true });
            throw new Error(t('Cannot replace rclone.exe (it may be in use). Close the remote workspace and try again. ({0})', error.code || error.message));
        }
        logger.info(`rclone ${version} installed: ${exePath}`);
        return { version: version.replace(/^v/, ''), exePath };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function queryRegistry(key, value) {
    return new Promise((resolve) => {
        execFile('reg.exe', ['query', key, '/v', value], { windowsHide: true }, (error, stdout) => {
            if (error) {
                resolve(undefined);
                return;
            }
            const match = new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`).exec(stdout || '');
            resolve(match ? match[1].trim() : undefined);
        });
    });
}

/** @returns {Promise<string|undefined>} WinFsp 설치 경로 */
async function findWinFsp() {
    for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\WinFsp', 'HKLM\\SOFTWARE\\WinFsp']) {
        const dir = await queryRegistry(key, 'InstallDir');
        if (dir && fs.existsSync(path.join(dir, 'bin'))) {
            return dir;
        }
    }
    return undefined;
}

module.exports = { installRclone, getLatestRcloneVersion, findWinFsp, rcloneArch };
