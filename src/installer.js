'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
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

// ---------------------------------------------------------------- uv (보드용 패키지 해석)

const PYPI_JSON = 'https://pypi.org/pypi';

function uvWheelTag() {
    if (process.arch === 'arm64') {
        return 'win_arm64';
    }
    return process.arch === 'ia32' ? 'win32' : 'win_amd64';
}

/** @returns {Promise<string|undefined>} uv 버전 (예: 0.13.0) */
async function getUvVersion(exe) {
    if (!exe || !fs.existsSync(exe)) {
        return undefined;
    }
    try {
        const result = await runProcess(exe, ['--version'], { timeoutMs: 15000 });
        const match = /^uv (\d+\.\d+\.\d+)/m.exec(result.stdout);
        return match ? match[1] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * PyPI에서 최신 uv(Windows 휠)를 내려받아 SHA-256을 검증하고 uv.exe만 binDir에 설치한다.
 * @returns {Promise<{version: string, exePath: string}>}
 */
async function installUv(options) {
    const logger = options.logger || noopLogger;
    const report = options.onProgress || (() => {});
    const tag = uvWheelTag();

    report(t('Checking the latest version...'));
    const meta = JSON.parse(await downloadText(`${PYPI_JSON}/uv/json`));
    const wheel = (meta.urls || []).find((file) => file.packagetype === 'bdist_wheel' && !file.yanked && file.filename.endsWith(`-py3-none-${tag}.whl`));
    const expected = wheel && wheel.digests && wheel.digests.sha256;
    if (!wheel || !/^[0-9a-f]{64}$/i.test(expected || '') || !/^https:\/\//.test(wheel.url)) {
        throw new Error(t('Could not find a uv package for this PC ({0}).', tag));
    }
    const version = String(meta.info && meta.info.version);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-remote-uv-'));
    try {
        const wheelPath = path.join(tempDir, 'uv.whl');
        logger.info(`Downloading uv: ${wheel.url}`);
        let lastPercent = -1;
        const actual = await downloadFile(wheel.url, wheelPath, (received, total) => {
            const percent = total ? Math.floor((received / total) * 100) : -1;
            if (percent !== lastPercent && percent % 5 === 0) {
                lastPercent = percent;
                report(t('Downloading {0}... {1}%', `uv ${version}`, percent));
            }
        });
        if (actual.toLowerCase() !== expected.toLowerCase()) {
            throw new Error(t('uv file verification failed (SHA-256 mismatch). Please try again.'));
        }

        // 휠은 zip 형식이다. uv.exe는 uv-<버전>.data/scripts/에 있다.
        report(t('Extracting...'));
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        const result = await runProcess(fs.existsSync(tar) ? tar : 'tar.exe', ['-xf', wheelPath, '-C', tempDir], { timeoutMs: 120000 });
        const dataDir = fs.readdirSync(tempDir).find((name) => /^uv-.*\.data$/.test(name));
        const extracted = dataDir && path.join(tempDir, dataDir, 'scripts', 'uv.exe');
        if (result.code !== 0 || !extracted || !fs.existsSync(extracted)) {
            throw new Error(t('Extraction failed: {0}', result.stderr.trim() || `exit ${result.code}`));
        }

        fs.mkdirSync(options.binDir, { recursive: true });
        const exePath = path.join(options.binDir, 'uv.exe');
        const staged = `${exePath}.new`;
        fs.copyFileSync(extracted, staged);
        try {
            fs.renameSync(staged, exePath);
        } catch (error) {
            fs.rmSync(staged, { force: true });
            throw new Error(t('Cannot replace uv.exe (it may be in use). Try again in a moment. ({0})', error.code || error.message));
        }
        logger.info(`uv ${version} installed: ${exePath}`);
        return { version, exePath };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

module.exports = { installRclone, getLatestRcloneVersion, rcloneArch, installUv, getUvVersion, downloadFile };
