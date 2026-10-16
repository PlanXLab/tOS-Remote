'use strict';

// 보드용 Python 패키지를 PC에서 해석·다운로드한다 (보드는 인터넷이 없어도 된다).
// uv로 보드의 Python 버전·플랫폼(manylinux) 기준으로 의존성을 해석하고(pylock.toml), PyPI에서 휠을 받아 SHA-256을 검증한다.
const fs = require('fs');
const path = require('path');
const { runProcess } = require('./util');
const { downloadFile } = require('./installer');
const { t } = require('./i18n');

// 해석에만 쓰는 PC 쪽 Python (uv가 확장 저장소에 한 번 내려받는다). 보드 Python 버전과 달라도 된다.
const RESOLVER_PYTHON = '3.12';
const DOWNLOAD_CONCURRENCY = 4;
const WHEEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*\.whl$/;

/** uv 실행 환경: 사용자 설정·다른 Python을 쓰지 않고 확장 전용 폴더만 사용한다. */
function uvEnv({ cacheDir, pythonDir }) {
    return {
        ...process.env,
        UV_CACHE_DIR: cacheDir,
        UV_PYTHON_INSTALL_DIR: pythonDir,
        UV_NO_CONFIG: '1',
        UV_PYTHON_PREFERENCE: 'only-managed',
        UV_PYTHON_DOWNLOADS: 'automatic',
        UV_NO_PROGRESS: '1',
        NO_COLOR: '1'
    };
}

/** uv pip compile 인자 (pylock: PEP 751 형식으로 휠 URL·SHA-256까지 출력) */
function compileArgs({ input, output, constraints, pythonVersion, platform, excludeNewer, pylock }) {
    const args = ['pip', 'compile', input];
    if (constraints) {
        args.push('--constraints', constraints);
    }
    args.push('--python', RESOLVER_PYTHON, '--python-version', pythonVersion, '--python-platform', platform, '--only-binary', ':all:', '--no-header');
    if (pylock) {
        args.push('--format', 'pylock.toml');
    } else {
        args.push('--no-annotate');
    }
    if (excludeNewer) {
        args.push('--exclude-newer', excludeNewer);
    }
    args.push('--output-file', output);
    return args;
}

/**
 * uv가 만든 pylock.toml에서 패키지별 휠(URL·SHA-256·크기)을 읽는다.
 * @returns {{name: string, version: string, wheels: {url: string, sha256: string, size: number, filename: string}[]}[]}
 */
function parsePylock(text) {
    const packages = [];
    const blocks = String(text || '').split(/^\[\[packages\]\][ \t]*\r?$/m).slice(1);
    for (const block of blocks) {
        const name = /^name\s*=\s*"([^"]+)"/m.exec(block);
        const version = /^version\s*=\s*"([^"]+)"/m.exec(block);
        if (!name || !version) {
            continue;
        }
        const urls = [...block.matchAll(/\burl\s*=\s*"([^"]+)"/g)];
        const wheels = [];
        urls.forEach((match, index) => {
            const segment = block.slice(match.index, index + 1 < urls.length ? urls[index + 1].index : block.length);
            const url = match[1];
            const filename = decodeURIComponent(url.split('/').pop() || '');
            if (!filename.endsWith('.whl')) {
                return;
            }
            const sha256 = /\bsha256\s*=\s*"([0-9a-fA-F]{64})"/.exec(segment);
            const size = /\bsize\s*=\s*(\d+)/.exec(segment);
            wheels.push({ url, filename, sha256: sha256 ? sha256[1].toLowerCase() : '', size: size ? Number(size[1]) : 0 });
        });
        packages.push({ name: name[1], version: version[1], wheels });
    }
    return packages;
}

// uv 오류 출력에서 원인 줄만 남긴다
function summarizeUvError(stderr) {
    const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(Resolved|Downloading|Downloaded)\b/.test(line));
    return lines.slice(0, 6).join('\n') || t('unknown error');
}

/**
 * 보드에 설치할 패키지를 해석한다. 보드에 이미 설치된 버전은 선호값으로 넘겨 가능한 한 그대로 쓴다.
 * @param {{uvPath: string, workDir: string, env: NodeJS.ProcessEnv, requirements: string[], constraints: string[],
 *          preferences: string[], pythonVersion: string, platform: string, excludeNewer?: string,
 *          onStderr?: (text: string) => void}} options
 */
async function resolvePackages(options) {
    const file = (name, lines) => {
        const target = path.join(options.workDir, name);
        fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
        return target;
    };
    const input = file('requirements.in', options.requirements);
    const constraints = file('constraints.txt', options.constraints);
    // uv pip compile은 기존 출력 파일의 고정 버전을 선호값으로 사용한다
    const pinned = file('requirements.txt', options.preferences);
    const pylock = path.join(options.workDir, 'pylock.toml');
    const common = { pythonVersion: options.pythonVersion, platform: options.platform, excludeNewer: options.excludeNewer };
    const run = async (args) => {
        const result = await runProcess(options.uvPath, args, { env: options.env, timeoutMs: 10 * 60 * 1000, onStderr: options.onStderr });
        if (result.code !== 0) {
            throw new Error(t('Could not resolve packages for the board: {0}', summarizeUvError(result.stderr)));
        }
    };
    await run(compileArgs({ ...common, input, constraints, output: pinned }));
    await run(compileArgs({ ...common, input: pinned, output: pylock, pylock: true }));
    const packages = parsePylock(fs.readFileSync(pylock, 'utf8'));
    for (const pkg of packages) {
        const valid = pkg.wheels.filter((wheel) => /^https:\/\//.test(wheel.url) && wheel.sha256 && WHEEL_NAME.test(wheel.filename));
        if (!valid.length) {
            throw new Error(t('No wheel for the board was found for {0} {1}.', pkg.name, pkg.version));
        }
        pkg.wheels = valid;
    }
    return packages;
}

/**
 * 휠을 내려받고 SHA-256을 검증한다.
 * @param {{url: string, sha256: string, size: number, filename: string}[]} wheels
 * @param {(received: number, total: number) => void} [onProgress]
 */
async function downloadWheels(wheels, dir, onProgress) {
    const total = wheels.reduce((sum, wheel) => sum + (wheel.size || 0), 0);
    const received = new Map();
    const report = () => {
        if (onProgress) {
            onProgress([...received.values()].reduce((a, b) => a + b, 0), total);
        }
    };
    const queue = [...wheels];
    const worker = async () => {
        for (let wheel = queue.shift(); wheel; wheel = queue.shift()) {
            const destination = path.join(dir, wheel.filename);
            const actual = await downloadFile(wheel.url, destination, (bytes) => {
                received.set(wheel.filename, bytes);
                report();
            });
            if (actual.toLowerCase() !== wheel.sha256) {
                fs.rmSync(destination, { force: true });
                throw new Error(t('Package verification failed (SHA-256 mismatch): {0}', wheel.filename));
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, wheels.length) }, worker));
    report();
}

module.exports = { RESOLVER_PYTHON, uvEnv, compileArgs, parsePylock, resolvePackages, downloadWheels };
