'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { t } = require('./i18n');

const noopLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const MAX_CAPTURE = 256 * 1024;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// POSIX 셸용 작은따옴표 인용
function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeRemotePath(value, fallback = '/') {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) {
        return fallback;
    }
    return '/' + text.split('/').filter(Boolean).join('/');
}

function normalizeDriveLetter(value) {
    const match = /^\s*([D-Zd-z])\s*:?\s*\\?\s*$/.exec(String(value || ''));
    return match ? `${match[1].toUpperCase()}:` : '';
}

function samePath(a, b) {
    if (!a || !b) {
        return false;
    }
    return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 4), 'utf8');
    fs.renameSync(temp, file);
}

function removeFile(file) {
    try {
        fs.unlinkSync(file);
    } catch {
        // 이미 없으면 무시
    }
}

function isProcessAlive(pid) {
    if (!pid) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

// PID 재사용으로 다른 프로세스를 종료하지 않도록 실행 파일 이름을 확인
function getProcessImageName(pid) {
    return new Promise((resolve) => {
        execFile('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
            if (error) {
                resolve(undefined);
                return;
            }
            const match = /^"([^"]+)"/m.exec(stdout || '');
            resolve(match ? match[1].toLowerCase() : undefined);
        });
    });
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function randomToken(bytes = 18) {
    return crypto.randomBytes(bytes).toString('hex');
}

// TCP 연결 후 첫 줄(SSH 배너)을 읽는다
function probeTcp(host, port, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        let banner = '';
        let connected = false;
        let done = false;
        const finish = (result) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => {
            finish(connected ? { ok: true, banner: banner.trim() } : { ok: false, error: t('timed out') });
        }, timeoutMs);
        socket.on('connect', () => {
            connected = true;
        });
        socket.on('data', (data) => {
            banner += data.toString('utf8');
            if (banner.includes('\n')) {
                finish({ ok: true, banner: banner.split(/\r?\n/)[0].trim() });
            }
        });
        socket.on('error', (error) => finish({ ok: false, error: error.message }));
    });
}

function appendCapped(current, chunk) {
    const next = current + chunk;
    return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/**
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
function runProcess(file, args, options = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(file, args, { windowsHide: true, env: options.env || process.env, cwd: options.cwd });
        } catch (error) {
            reject(error);
            return;
        }
        let stdout = '';
        let stderr = '';
        let timer;
        if (options.timeoutMs) {
            timer = setTimeout(() => child.kill(), options.timeoutMs);
        }
        child.stdout.on('data', (data) => {
            const text = data.toString('utf8');
            stdout = appendCapped(stdout, text);
            if (options.onStdout) {
                options.onStdout(text);
            }
        });
        child.stderr.on('data', (data) => {
            const text = data.toString('utf8');
            stderr = appendCapped(stderr, text);
            if (options.onStderr) {
                options.onStderr(text);
            }
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.stdin.on('error', () => {});
        if (options.input !== undefined) {
            child.stdin.end(options.input);
        } else {
            child.stdin.end();
        }
    });
}

function findExecutable(name) {
    const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function lastLine(text) {
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
}

module.exports = {
    noopLogger,
    sleep,
    shellQuote,
    normalizeRemotePath,
    normalizeDriveLetter,
    samePath,
    readJson,
    writeJson,
    removeFile,
    isProcessAlive,
    getProcessImageName,
    getFreePort,
    randomToken,
    probeTcp,
    runProcess,
    findExecutable,
    lastLine
};
