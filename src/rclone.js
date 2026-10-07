'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const {
    sleep, readJson, writeJson, removeFile, isProcessAlive, getProcessImageName,
    getFreePort, randomToken, runProcess, noopLogger
} = require('./util');
const { t } = require('./i18n');

const MIN_VERSION = '1.65.0';
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const VFS_OPTIONS = {
    CacheMode: 'full',
    // 저장 후 실행(F5/Ctrl+F5)까지의 대기 시간을 줄이기 위해 짧게 둔다
    WriteBack: '200ms',
    DirCacheTime: '10s',
    PollInterval: '0s',
    NoModTime: true,
    Links: true
};
const MOUNT_OPTIONS = {
    VolumeName: 'tOS',
    AttrTimeout: '1s'
};

function compareVersions(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

// rclone 접속 문자열 값 인용 (작은따옴표, 내부 따옴표는 두 번)
function quoteValue(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {{host: string, port: number, user: string}} target
 * @param {{type: 'key', keyPath: string} | {type: 'password', obscured: string}} auth
 */
function sftpConnectionString(target, auth, remotePath) {
    const parts = [
        `host=${quoteValue(target.host)}`,
        `port=${target.port}`,
        `user=${quoteValue(target.user)}`,
        'shell_type=unix',
        'disable_hashcheck=true',
        'known_hosts_file=none'
    ];
    if (auth.type === 'key') {
        parts.push(`key_file=${quoteValue(auth.keyPath.replace(/\\/g, '/'))}`);
    } else {
        parts.push(`pass=${quoteValue(auth.obscured)}`);
    }
    return `:sftp,${parts.join(',')}:${remotePath}`;
}

// CLI 실행 시 비밀번호가 명령줄에 노출되지 않도록 환경 변수로 전달
function sftpEnv(target, auth) {
    const env = {
        RCLONE_SFTP_HOST: target.host,
        RCLONE_SFTP_PORT: String(target.port),
        RCLONE_SFTP_USER: target.user,
        RCLONE_SFTP_SHELL_TYPE: 'unix',
        RCLONE_SFTP_DISABLE_HASHCHECK: 'true',
        RCLONE_SFTP_KNOWN_HOSTS_FILE: 'none'
    };
    if (auth.type === 'key') {
        env.RCLONE_SFTP_KEY_FILE = auth.keyPath;
    } else {
        env.RCLONE_SFTP_PASS = auth.obscured;
    }
    return env;
}

function rcRequest(state, command, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(params || {});
        const request = http.request({
            host: '127.0.0.1',
            port: state.port,
            path: `/${command}`,
            method: 'POST',
            timeout: timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                Authorization: `Basic ${Buffer.from(`${state.user}:${state.pass}`).toString('base64')}`
            }
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    data = text;
                }
                if (response.statusCode !== 200) {
                    reject(new Error((data && data.error) || `rclone rc ${command}: HTTP ${response.statusCode}`));
                } else {
                    resolve(data);
                }
            });
        });
        request.on('timeout', () => request.destroy(new Error(t('rclone rc {0}: timed out', command))));
        request.on('error', reject);
        request.end(body);
    });
}

class Rclone {
    /**
     * @param {{storageDir: string, cacheDir: string, getExePath: () => string, logger?: object}} options
     */
    constructor(options) {
        this.storageDir = options.storageDir;
        this.cacheDir = options.cacheDir;
        this.getExePath = options.getExePath;
        this.logger = options.logger || noopLogger;
        this.stateFile = path.join(this.storageDir, 'rcd.json');
        this.logFile = path.join(this.storageDir, 'rclone.log');
        this.configFile = path.join(this.storageDir, 'rclone.conf');
        this.startPromise = undefined;
    }

    get exePath() {
        return this.getExePath();
    }

    async getVersion(exe = this.exePath) {
        if (!exe || !fs.existsSync(exe)) {
            return undefined;
        }
        try {
            const result = await runProcess(exe, ['version'], { timeoutMs: 15000 });
            const match = /rclone v(\d+\.\d+\.\d+)/.exec(result.stdout);
            return match ? match[1] : undefined;
        } catch {
            return undefined;
        }
    }

    static isSupportedVersion(version) {
        return !!version && compareVersions(version, MIN_VERSION) >= 0;
    }

    readState() {
        return readJson(this.stateFile);
    }

    async isDaemonAlive(state = this.readState()) {
        if (!state || !state.port) {
            return false;
        }
        try {
            const result = await rcRequest(state, 'core/pid', {}, 3000);
            return !!result && result.pid === state.pid;
        } catch {
            return false;
        }
    }

    async call(command, params, timeoutMs) {
        const state = this.readState();
        if (!state) {
            throw new Error(t('The rclone daemon is not running.'));
        }
        return rcRequest(state, command, params, timeoutMs);
    }

    ensureDaemon() {
        // 같은 창에서 동시에 호출되어도 데몬은 하나만 띄운다
        if (!this.startPromise) {
            this.startPromise = this.startDaemon().finally(() => {
                this.startPromise = undefined;
            });
        }
        return this.startPromise;
    }

    async startDaemon() {
        const existing = this.readState();
        if (await this.isDaemonAlive(existing)) {
            return existing;
        }
        if (existing && isProcessAlive(existing.pid) && (await getProcessImageName(existing.pid)) === 'rclone.exe') {
            this.logger.warn(`Killing unresponsive rclone daemon (pid ${existing.pid})`);
            try {
                process.kill(existing.pid);
            } catch {
                // 이미 종료됨
            }
        }
        removeFile(this.stateFile);

        const exe = this.exePath;
        if (!exe || !fs.existsSync(exe)) {
            throw new Error(t('rclone.exe is missing. Install rclone first.'));
        }
        fs.mkdirSync(this.storageDir, { recursive: true });
        fs.mkdirSync(this.cacheDir, { recursive: true });
        if (!fs.existsSync(this.configFile)) {
            fs.writeFileSync(this.configFile, '', 'utf8');
        }
        try {
            if (fs.statSync(this.logFile).size > MAX_LOG_BYTES) {
                fs.renameSync(this.logFile, `${this.logFile}.old`);
            }
        } catch {
            // 로그 없음
        }

        const port = await getFreePort();
        const state = { pid: 0, port, user: 'tos-remote', pass: randomToken(), exe, startedAt: Date.now() };
        const args = [
            'rcd',
            `--rc-addr=127.0.0.1:${port}`,
            `--config=${this.configFile}`,
            `--cache-dir=${this.cacheDir}`,
            `--log-file=${this.logFile}`,
            '--log-level=INFO',
            // 보드 연결이 끊겼을 때 드라이브 접근이 오래 멈추지 않도록 네트워크 대기 시간을 줄인다
            '--contimeout=10s',
            '--timeout=60s',
            '--low-level-retries=3'
        ];

        // 창 재로드/종료 후에도 마운트가 유지되도록 확장 프로세스와 분리해 실행
        const child = spawn(exe, args, {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, RCLONE_RC_USER: state.user, RCLONE_RC_PASS: state.pass }
        });
        let exitCode;
        child.on('exit', (code) => {
            exitCode = code === null ? -1 : code;
        });
        child.on('error', (error) => {
            exitCode = -1;
            this.logger.error(`Failed to start the rclone daemon: ${error.message}`);
        });
        child.unref();
        state.pid = child.pid;

        for (let i = 0; i < 75; i++) {
            await sleep(200);
            if (exitCode !== undefined) {
                break;
            }
            if (await this.isDaemonAlive(state)) {
                writeJson(this.stateFile, state);
                this.logger.info(`rclone daemon started (pid ${state.pid}, port ${port})`);
                return state;
            }
        }
        if (exitCode === undefined && isProcessAlive(state.pid)) {
            try {
                process.kill(state.pid);
            } catch {
                // 무시
            }
        }
        throw new Error(t('Could not start the rclone daemon. Check the log: {0}', this.logFile));
    }

    async quitDaemon() {
        const state = this.readState();
        if (!state) {
            return;
        }
        try {
            await rcRequest(state, 'core/quit', {}, 5000);
        } catch {
            // 이미 종료됨
        }
        for (let i = 0; i < 25 && isProcessAlive(state.pid); i++) {
            await sleep(200);
        }
        if (isProcessAlive(state.pid) && (await getProcessImageName(state.pid)) === 'rclone.exe') {
            try {
                process.kill(state.pid);
            } catch {
                // 무시
            }
        }
        removeFile(this.stateFile);
        this.logger.info('rclone daemon stopped');
    }

    async listMounts() {
        const result = await this.call('mount/listmounts', {}, 10000);
        return (result && result.mountPoints) || [];
    }

    async isMounted(drive) {
        if (!drive) {
            return false;
        }
        // 보드 연결이 끊기면 드라이브 접근이 멈출 수 있으므로 드라이브를 직접 조회하지 않고 rclone 목록만 확인한다
        try {
            const mounts = await this.listMounts();
            return mounts.some((m) => String(m.MountPoint).toUpperCase() === drive.toUpperCase());
        } catch {
            return false;
        }
    }

    async mkdir(fsString) {
        await this.call('operations/mkdir', { fs: fsString, remote: '' }, 60000);
    }

    async mount(fsString, drive) {
        await this.call('mount/mount', {
            fs: fsString,
            mountPoint: drive,
            vfsOpt: VFS_OPTIONS,
            mountOpt: MOUNT_OPTIONS
        }, 60000);
        for (let i = 0; i < 75; i++) {
            if (fs.existsSync(`${drive}\\`)) {
                return;
            }
            await sleep(200);
        }
        throw new Error(t('Drive {0} did not appear. Check the WinFsp installation and the rclone log.', drive));
    }

    async unmount(drive) {
        try {
            await this.call('mount/unmount', { mountPoint: drive }, 30000);
        } catch (error) {
            this.logger.warn(`Unmount error (${drive}): ${error.message}`);
        }
    }

    // 보드로 아직 업로드되지 않은 파일 수 (VFS 쓰기 지연 대기열)
    async pendingUploads() {
        try {
            const result = await this.call('vfs/queue', {}, 5000);
            return ((result && result.queue) || []).length;
        } catch {
            return 0;
        }
    }

    async refresh() {
        await this.call('vfs/refresh', { recursive: 'true' }, 120000);
    }

    runCli(args, options = {}) {
        const exe = this.exePath;
        if (!exe || !fs.existsSync(exe)) {
            throw new Error(t('rclone.exe is missing. Install rclone first.'));
        }
        return runProcess(exe, [...args, `--config=${this.configFile}`], {
            env: { ...process.env, ...(options.env || {}) },
            input: options.input,
            timeoutMs: options.timeoutMs,
            onStderr: options.onStderr
        });
    }
}

module.exports = { Rclone, sftpConnectionString, sftpEnv, compareVersions, MIN_VERSION };
