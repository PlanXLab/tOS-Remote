'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { runProcess, findExecutable, noopLogger } = require('./util');
const { t } = require('./i18n');

const RCLONE_DOWNLOAD_BASE = 'https://downloads.rclone.org';
const USER_AGENT = 'tos-remote (VS Code extension)';

function rclonePlatform(platform = process.platform) {
    const platforms = { win32: 'windows', linux: 'linux', darwin: 'osx' };
    if (!platforms[platform]) {
        throw new Error(t('rclone is not available on this operating system: {0}', platform));
    }
    return platforms[platform];
}

function rcloneArch(arch = process.arch) {
    const architectures = { arm64: 'arm64', arm: 'arm-v7', ia32: '386', x64: 'amd64' };
    if (!architectures[arch]) {
        throw new Error(t('rclone is not available for this processor architecture: {0}', arch));
    }
    return architectures[arch];
}

function rcloneExecutableName(platform = process.platform) {
    return platform === 'win32' ? 'rclone.exe' : 'rclone';
}

function getRclonePackageManager(platform = process.platform, locate = findExecutable) {
    const managers = {
        win32: [
            { label: 'winget', executable: 'winget.exe', args: ['install', '--exact', '--id', 'Rclone.Rclone', '--accept-source-agreements', '--accept-package-agreements'] },
            { label: 'Scoop', executable: 'scoop.cmd', args: ['install', 'rclone'], shell: true },
            { label: 'Chocolatey', executable: 'choco.exe', args: ['install', 'rclone', '--yes'] }
        ],
        darwin: [
            { label: 'Homebrew', executable: 'brew', args: ['install', 'rclone'] },
            { label: 'MacPorts', executable: 'port', args: ['install', 'rclone'], requiresSudo: true }
        ],
        linux: [
            { label: 'apt', executable: 'apt-get', args: ['install', '-y', 'rclone'], requiresSudo: true },
            { label: 'DNF', executable: 'dnf', args: ['install', '-y', 'rclone'], requiresSudo: true },
            { label: 'Pacman', executable: 'pacman', args: ['-S', '--noconfirm', 'rclone'], requiresSudo: true },
            { label: 'Zypper', executable: 'zypper', args: ['--non-interactive', 'install', 'rclone'], requiresSudo: true },
            { label: 'YUM', executable: 'yum', args: ['install', '-y', 'rclone'], requiresSudo: true },
            { label: 'APK', executable: 'apk', args: ['add', '--no-progress', 'rclone'], requiresSudo: true }
        ]
    };
    for (const manager of managers[platform] || []) {
        const command = locate(manager.executable);
        if (command) {
            return { ...manager, command };
        }
    }
    return undefined;
}

async function extractZip(zipPath, destination) {
    const candidates = [];
    if (process.platform === 'win32') {
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        candidates.push({
            file: fs.existsSync(tar) ? tar : (findExecutable('tar.exe') || 'tar.exe'),
            args: ['-xf', zipPath, '-C', destination]
        });
    } else {
        if (process.platform === 'darwin' && fs.existsSync('/usr/bin/ditto')) {
            candidates.push({ file: '/usr/bin/ditto', args: ['-x', '-k', zipPath, destination] });
        }
        for (const name of ['unzip', 'bsdtar', 'tar']) {
            const file = findExecutable(name);
            if (file) {
                candidates.push({
                    file,
                    args: name === 'unzip' ? ['-q', zipPath, '-d', destination] : ['-xf', zipPath, '-C', destination]
                });
            }
        }
    }

    const errors = [];
    for (const candidate of candidates) {
        const result = await runProcess(candidate.file, candidate.args, { timeoutMs: 120000 });
        if (result.code === 0) {
            return;
        }
        errors.push(`${path.basename(candidate.file)}: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    throw new Error(t('Could not extract the downloaded archive: {0}', errors.join('; ') || t('No ZIP extraction utility was found.')));
}

function installExecutable(source, destination, getReplaceError) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staged = `${destination}.new`;
    try {
        fs.copyFileSync(source, staged);
        if (process.platform !== 'win32') {
            fs.chmodSync(staged, 0o755);
        }
        fs.renameSync(staged, destination);
    } catch (error) {
        fs.rmSync(staged, { force: true });
        throw new Error(getReplaceError(error.code || error.message));
    }
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
 * 최신 rclone을 임시 폴더에 내려받아 SHA-256을 검증하고 실행 파일만 binDir에 설치한다.
 * @returns {Promise<{version: string, exePath: string}>}
 */
async function installRclone(options) {
    const logger = options.logger || noopLogger;
    const report = options.onProgress || (() => {});
    const arch = rcloneArch();
    const platform = rclonePlatform();
    const executable = rcloneExecutableName();

    report(t('Checking the latest version...'));
    const version = await getLatestRcloneVersion();
    const zipName = `rclone-${version}-${platform}-${arch}.zip`;
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
        await extractZip(zipPath, tempDir);
        const extracted = path.join(tempDir, `rclone-${version}-${platform}-${arch}`, executable);
        if (!fs.existsSync(extracted)) {
            throw new Error(t('The downloaded archive does not contain {0}.', executable));
        }

        const exePath = path.join(options.binDir, executable);
        installExecutable(extracted, exePath, (detail) => t('Cannot replace rclone (it may be in use). Close the remote workspace and try again. ({0})', detail));
        logger.info(`rclone ${version} installed: ${exePath}`);
        return { version: version.replace(/^v/, ''), exePath };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------- uv (보드용 패키지 해석)

const PYPI_JSON = 'https://pypi.org/pypi';

function uvWheelTags(platform = process.platform, arch = process.arch, libc) {
    if (platform === 'win32') {
        const tags = { arm64: ['win_arm64'], ia32: ['win32'], x64: ['win_amd64'] };
        if (tags[arch]) {
            return tags[arch];
        }
    }
    if (platform === 'darwin') {
        const tags = { arm64: ['macosx_11_0_arm64'], x64: ['macosx_10_12_x86_64'] };
        if (tags[arch]) {
            return tags[arch];
        }
    }
    if (platform === 'linux') {
        const linuxArch = { arm64: 'aarch64', arm: 'armv7l', ia32: 'i686', x64: 'x86_64' }[arch];
        if (linuxArch) {
            if (!libc) {
                const report = process.report && process.report.getReport();
                libc = report && report.header && report.header.glibcVersionRuntime ? 'glibc' : 'musl';
            }
            const manylinux = [`manylinux_2_17_${linuxArch}`, `manylinux2014_${linuxArch}`];
            const musllinux = [`musllinux_1_2_${linuxArch}`, `musllinux_1_1_${linuxArch}`];
            return libc === 'musl' ? musllinux : manylinux;
        }
    }
    throw new Error(t('uv is not available for this operating system or processor architecture ({0}, {1}).', platform, arch));
}

function selectUvWheel(files, tags) {
    for (const tag of tags) {
        const wheel = files.find((file) => {
            if (file.packagetype !== 'bdist_wheel' || file.yanked) {
                return false;
            }
            const match = /-py3-none-([^-]+)\.whl$/.exec(file.filename);
            return !!match && match[1].split('.').includes(tag);
        });
        if (wheel) {
            return wheel;
        }
    }
    return undefined;
}

function uvExecutableName(platform = process.platform) {
    return platform === 'win32' ? 'uv.exe' : 'uv';
}

/** @returns {Promise<string|undefined>} uv 버전 (예: 0.13.0) */
async function getUvVersion(exe) {
    if (!exe || !fs.existsSync(exe)) {
        return undefined;
    }
    try {
        const result = await runProcess(exe, ['--version'], { timeoutMs: 15000 });
        const match = /^uv (\d+\.\d+\.\d+)/m.exec(result.stdout);
        return result.code === 0 && match ? match[1] : undefined;
    } catch {
        return undefined;
    }
}

/**
 * PyPI에서 현재 플랫폼용 uv 휠을 내려받아 SHA-256을 검증하고 실행 파일만 binDir에 설치한다.
 * @returns {Promise<{version: string, exePath: string}>}
 */
async function installUv(options) {
    const logger = options.logger || noopLogger;
    const report = options.onProgress || (() => {});
    const tags = uvWheelTags();

    report(t('Checking the latest version...'));
    const meta = JSON.parse(await downloadText(`${PYPI_JSON}/uv/json`));
    const wheel = selectUvWheel(meta.urls || [], tags);
    const expected = wheel && wheel.digests && wheel.digests.sha256;
    if (!wheel || !/^[0-9a-f]{64}$/i.test(expected || '') || !/^https:\/\//.test(wheel.url)) {
        throw new Error(t('Could not find a uv package for this PC ({0}).', tags.join(', ')));
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

        // 휠은 zip 형식이며 uv 실행 파일은 uv-<버전>.data/scripts/에 있다.
        report(t('Extracting...'));
        await extractZip(wheelPath, tempDir);
        const dataDir = fs.readdirSync(tempDir).find((name) => /^uv-.*\.data$/.test(name));
        const executable = uvExecutableName();
        const extracted = dataDir && path.join(tempDir, dataDir, 'scripts', executable);
        if (!extracted || !fs.existsSync(extracted)) {
            throw new Error(t('The downloaded archive does not contain {0}.', executable));
        }

        const exePath = path.join(options.binDir, executable);
        installExecutable(extracted, exePath, (detail) => t('Cannot replace uv (it may be in use). Try again in a moment. ({0})', detail));
        logger.info(`uv ${version} installed: ${exePath}`);
        return { version, exePath };
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

module.exports = {
    installRclone, getLatestRcloneVersion, rclonePlatform, rcloneArch, rcloneExecutableName,
    getRclonePackageManager, installUv, getUvVersion, uvWheelTags, selectUvWheel, uvExecutableName, downloadFile
};
