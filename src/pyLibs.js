'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { shellQuote, normalizeRemotePath, lastLine, noopLogger } = require('./util');
const { sftpEnv } = require('./rclone');
const { TOOLS_PROBE_PY, parseProbeOutput } = require('./boardScripts');

// 라이브러리 종류: system(전역, 필수) · custom(사용자 지정, 필수) · user(~/.local, 선택) · venv(작업 공간 가상 환경, 선택)
const REQUIRED_KINDS = new Set(['system', 'custom']);
const KINDS = new Set(['system', 'custom', 'user', 'venv']);

function isRequired(library) {
    return REQUIRED_KINDS.has(library.kind);
}

// 자동 감지 실패 시 사용하는 tOS-Lite 문서 기준 경로
function defaultLibraries(user) {
    return [
        { remote: '/var/lib/tos/uv/python/cpython-3.12-linux-aarch64-gnu/lib/python3.12/site-packages', kind: 'system' },
        { remote: `/home/${user}/.local/lib/python3.12/site-packages`, kind: 'user' }
    ];
}

/** 이전 버전 세션(libraryPaths 배열)과의 호환 */
function sessionLibraries(session) {
    if (!session) {
        return [];
    }
    if (Array.isArray(session.libraries)) {
        return session.libraries;
    }
    return (session.libraryPaths || []).map((remote) => ({ remote, kind: /\/\.local\//.test(remote) ? 'user' : 'system' }));
}

function cacheRoot() {
    return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'tOS Remote', 'python-libs');
}

function localCachePath(remotePath) {
    const name = remotePath.replace(/^\/+/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'root';
    return path.join(cacheRoot(), name);
}

function hasCache(localPath) {
    try {
        return fs.readdirSync(localPath).length > 0;
    } catch {
        return false;
    }
}

/**
 * 보드 Python 감지 결과 파싱. 각 줄은 "종류<TAB>실제경로<TAB>원래경로" 형식이다.
 * 심볼릭 링크로 같은 폴더를 가리키는 경로는 하나로 합치고, 원래 경로는 별칭으로 남긴다(터미널 링크·디버그 매핑용).
 * @returns {{libraries: {remote: string, kind: string}[], aliases: {remote: string, real: string}[]}}
 */
function parseDetectedPaths(stdout) {
    const libraries = [];
    const aliases = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const [kindRaw, realRaw, originalRaw] = line.split('\t');
        const kind = String(kindRaw || '').trim();
        if (!KINDS.has(kind) || !realRaw || !realRaw.trim().startsWith('/')) {
            continue;
        }
        const real = normalizeRemotePath(realRaw);
        if (!libraries.some((l) => l.remote === real)) {
            libraries.push({ remote: real, kind });
        }
        const original = originalRaw && originalRaw.trim().startsWith('/') ? normalizeRemotePath(originalRaw) : real;
        if (original !== real && !aliases.some((a) => a.remote === original)) {
            aliases.push({ remote: original, real });
        }
    }
    return { libraries, aliases };
}

// 보드에서 실행할 감지 스크립트: 전역·사용자 site-packages와 작업 공간의 가상 환경(pyvenv.cfg, 2단계 깊이까지)을 찾는다
const DETECT_SCRIPT = [
    'import glob, os, site, sys',
    'def emit(kind, p):',
    '    r = os.path.realpath(p)',
    '    if os.path.isdir(r): print(kind + chr(9) + r + chr(9) + p)',
    'for p in site.getsitepackages(): emit("system", p)',
    'emit("user", site.getusersitepackages())',
    'ws = os.path.realpath(sys.argv[1])',
    'for root, dirs, files in os.walk(ws):',
    '    if "pyvenv.cfg" in files:',
    '        for sp in sorted(glob.glob(os.path.join(root, "lib", "python*", "site-packages"))): emit("venv", sp)',
    '        dirs[:] = []',
    '        continue',
    '    depth = 0 if root == ws else os.path.relpath(root, ws).count(os.sep) + 1',
    '    dirs[:] = [] if depth >= 2 else [d for d in dirs if d not in ("node_modules", "__pycache__", ".git")]'
].join('\n');

/**
 * 보드의 Python에 라이브러리 경로를 질의한다. 같은 연결에서 보드 도구(debugpy·Jupyter) 상태도 확인한다.
 * @param {{keyPath?: string, password?: string}} sshAuth 키 또는 비밀번호(SSH_ASKPASS)
 * @returns {Promise<{libraries: object[], aliases: object[], tools?: object}|undefined>}
 */
async function detectRemoteLibraries(ssh, target, sshAuth, pythonCommand, remoteWorkspace, logger = noopLogger) {
    try {
        const script = `${DETECT_SCRIPT}\n${TOOLS_PROBE_PY}`;
        const command = `${pythonCommand} -c ${shellQuote(script)} ${shellQuote(remoteWorkspace)}`;
        const result = await ssh.exec(target, command, { ...sshAuth, timeoutMs: 30000 });
        if (result.code !== 0) {
            logger.warn(`Python library path detection failed: ${lastLine(result.stderr) || `exit ${result.code}`}`);
            return undefined;
        }
        const detected = parseDetectedPaths(result.stdout);
        const tools = parseProbeOutput(result.stdout);
        if (tools && !tools.error) {
            detected.tools = tools;
        }
        return detected.libraries.length ? detected : undefined;
    } catch (error) {
        logger.warn(`Python library path detection error: ${error.message}`);
        return undefined;
    }
}

/**
 * .py/.pyi만 로컬 캐시로 동기화 (Pylance 분석용)
 * @returns {Promise<string|undefined>} 로컬 캐시 경로. 보드에 경로가 없으면(예: ~/.local 사용자 패키지 미설치) undefined
 */
async function syncLibrary(rclone, target, auth, remotePath, onProgress) {
    const local = localCachePath(remotePath);
    const args = [
        'sync', `:sftp:${remotePath}`, local,
        '--filter', '- __pycache__/**',
        '--filter', '- tests/**',
        '--filter', '+ *.py',
        '--filter', '+ *.pyi',
        '--filter', '+ py.typed',
        '--filter', '- **',
        // Dropbear는 같은 IP의 동시 미인증 연결 수를 제한하므로 SSH 연결 수를 4개로 묶는다.
        // (터미널·디버그 SSH 접속이 거부되어 exit 255가 나는 것을 방지. --check-first 시 연결 수는 max(transfers, checkers)+1 필요)
        '--check-first',
        '--transfers', '3',
        '--checkers', '3',
        '--sftp-connections', '4',
        '--stats', '2s',
        '--stats-one-line',
        '--stats-log-level', 'NOTICE'
    ];
    const result = await rclone.runCli(args, {
        env: sftpEnv(target, auth),
        timeoutMs: 30 * 60 * 1000,
        onStderr: (text) => {
            const line = lastLine(text);
            if (onProgress && line) {
                onProgress(line.replace(/^.*NOTICE:\s*/, ''));
            }
        }
    });
    if (result.code !== 0) {
        // 선택 경로가 보드에 없으면 실패가 아니라 건너뛴다
        if (/directory not found/i.test(result.stderr)) {
            return undefined;
        }
        throw new Error(lastLine(result.stderr) || `rclone sync exit ${result.code}`);
    }
    return local;
}

module.exports = {
    isRequired,
    defaultLibraries,
    sessionLibraries,
    cacheRoot,
    localCachePath,
    hasCache,
    parseDetectedPaths,
    detectRemoteLibraries,
    syncLibrary,
    DETECT_SCRIPT
};
