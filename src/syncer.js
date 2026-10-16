'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sftpConnectionString, sftpEnv } = require('./rclone');
const { noopLogger } = require('./util');

let vscode;
try {
    vscode = require('vscode');
} catch {
    vscode = undefined;
}

function createEmitter() {
    if (vscode && vscode.EventEmitter) {
        return new vscode.EventEmitter();
    }
    const listeners = new Set();
    return {
        event: (fn) => {
            listeners.add(fn);
            return { dispose: () => listeners.delete(fn) };
        },
        fire: (value) => {
            for (const fn of listeners) {
                fn(value);
            }
        },
        dispose: () => listeners.clear()
    };
}

// 동기화에서 제외할 패턴들
const DEFAULT_EXCLUDES = [
    '.git/**',
    '.venv/**',
    'venv/**',
    '__pycache__/**',
    '*.pyc',
    '.vscode/**',
    '.DS_Store',
    '*.tmp'
];

const EXCLUDED_DIRS = new Set(['.git', '.venv', 'venv', '__pycache__', '.vscode']);
const REMOTE_SCAN_INTERVAL_MS = 3000;

/**
 * 로컬 경로를 보드 상대 경로(POSIX 포맷)로 변환
 */
function toRelativePosix(rootPath, filePath) {
    if (!rootPath || !filePath) {
        return undefined;
    }
    const rel = path.relative(rootPath, filePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
    }
    return rel.split(path.sep).join('/');
}

/**
 * 기본 제외 규칙에 해당하는지 확인
 */
function isExcluded(relPosix) {
    if (!relPosix) {
        return true;
    }
    const parts = relPosix.split('/');
    for (const part of parts) {
        if (EXCLUDED_DIRS.has(part)) {
            return true;
        }
    }
    if (relPosix.endsWith('.pyc') || relPosix.endsWith('.tmp') || relPosix.endsWith('.DS_Store')) {
        return true;
    }
    return false;
}

function fileSignature(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
            return undefined;
        }
        let hash = '';
        if (stat.size <= 1024 * 1024) {
            hash = crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
        }
        return { mtimeMs: stat.mtimeMs, size: stat.size, hash };
    } catch {
        return undefined;
    }
}

function sameSignature(a, b) {
    if (!a || !b) {
        return false;
    }
    if (a.size !== b.size) {
        return false;
    }
    if (a.hash && b.hash) {
        return a.hash === b.hash;
    }
    return a.mtimeMs === b.mtimeMs;
}

class Syncer {
    /**
     * @param {{rclone: any, resolveAuth?: (session: any) => Promise<any>, logger?: any}} options
     */
    constructor(options) {
        this.rclone = options.rclone;
        this.resolveAuth = options.resolveAuth;
        this.logger = options.logger || noopLogger;
        this.queue = new Map(); // relPosix -> { action: 'copy'|'delete', localPath, remoteRel }
        this.syncedFiles = new Map(); // relPosix -> { mtimeMs, size, hash }
        this.syncedRemoteFiles = new Map(); // relPosix -> { mtimeMs, size }
        this.syncedDirs = new Set();
        this.syncedRemoteDirs = new Set();
        this.remoteScanTimer = undefined;
        this.remoteScanRunning = false;
        this.activeTransfers = 0;
        this.activePaths = new Set();
        this.maxTransfers = 2;
        this.lastError = undefined;
        this.flushWaiters = [];
        this.watcher = undefined;
        this.fsWatcher = undefined;
        this.debounceTimers = new Map();
        this.emitter = createEmitter();
        this.onDidChange = this.emitter.event;
        this.sessionInfo = undefined;
        this.disposed = false;
    }

    get pendingCount() {
        return this.queue.size + this.activeTransfers;
    }

    notifyChange() {
        this.emitter.fire(this.pendingCount);
    }

    /**
     * 로컬 폴더의 현재 파일 상태를 기준 스냅샷으로 기록
     */
    recordSnapshot(localDir) {
        this.snapshotDir = localDir;
        this.syncedFiles.clear();
        this.syncedDirs.clear();
        if (!localDir || !fs.existsSync(localDir)) {
            return;
        }
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPosix = toRelativePosix(localDir, fullPath);
                if (!relPosix || isExcluded(relPosix)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    this.syncedDirs.add(relPosix);
                    walk(fullPath);
                } else if (entry.isFile()) {
                    const sig = fileSignature(fullPath);
                    if (sig) {
                        this.syncedFiles.set(relPosix, sig);
                    }
                }
            }
        };
        walk(localDir);
    }

    /**
     * 감시 이벤트가 아직 도착하지 않은 변경 사항을 스냅샷과 비교해 대기열에 반영
     */
    scanChanges() {
        if (!this.sessionInfo || !this.sessionInfo.localWorkspace) {
            return;
        }
        const localDir = this.sessionInfo.localWorkspace;
        if (!fs.existsSync(localDir)) {
            return;
        }
        const seen = new Set();
        const seenDirs = new Set();
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relPosix = toRelativePosix(localDir, fullPath);
                if (!relPosix || isExcluded(relPosix)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    seenDirs.add(relPosix);
                    if (!this.syncedDirs.has(relPosix)) {
                        this.queue.set(relPosix, { action: 'mkdir', localPath: fullPath, remoteRel: relPosix });
                    }
                    walk(fullPath);
                } else if (entry.isFile()) {
                    seen.add(relPosix);
                    const sig = fileSignature(fullPath);
                    if (sig && !sameSignature(sig, this.syncedFiles.get(relPosix))) {
                        this.queue.set(relPosix, { action: 'copy', localPath: fullPath, remoteRel: relPosix });
                    }
                }
            }
        };
        walk(localDir);

        for (const relPosix of this.syncedDirs) {
            if (!seenDirs.has(relPosix)) {
                this.queue.set(relPosix, { action: 'deleteDirectory', localPath: path.join(localDir, ...relPosix.split('/')), remoteRel: relPosix });
            }
        }

        for (const relPosix of this.syncedFiles.keys()) {
            if (!seen.has(relPosix) && !this.queue.has(relPosix)) {
                const fullPath = path.join(localDir, ...relPosix.split('/'));
                this.queue.set(relPosix, { action: 'delete', localPath: fullPath, remoteRel: relPosix });
            }
        }
    }

    /**
     * 초기 동기화: 보드의 소스 코드를 로컬 작업 사본으로 가져오기
     * @param {string} localDir
     * @param {{host: string, port: number, user: string}} target
     * @param {any} auth
     * @param {string} remoteWorkspace
     * @param {(msg: string) => void} [onProgress]
     */
    async initialPull(localDir, target, auth, remoteWorkspace, onProgress) {
        fs.mkdirSync(localDir, { recursive: true });

        // 보드 -> 로컬 복사 (기본 제외 목록 적용, 비밀번호는 환경 변수로 전달)
        const filterArgs = [];
        for (const pattern of DEFAULT_EXCLUDES) {
            filterArgs.push('--filter', `- ${pattern}`);
        }

        const args = [
            'copy',
            `:sftp:${remoteWorkspace}`,
            localDir,
            ...filterArgs,
            '--sftp-connections', '2',
            '--transfers', '2',
            '--checkers', '2',
            '--create-empty-src-dirs',
            '--stats', '1s',
            '--stats-one-line'
        ];

        this.logger.info(`Initial pull from ${remoteWorkspace} to ${localDir}`);
        const result = await this.rclone.runCli(args, {
            env: sftpEnv(target, auth),
            timeoutMs: 10 * 60 * 1000,
            onStderr: (text) => {
                if (onProgress) {
                    onProgress(text.trim());
                }
            }
        });

        if (result.code !== 0) {
            // 보드 폴더가 비어 있거나 없는 경우
            if (/directory not found/i.test(result.stderr)) {
                this.logger.info('Remote directory is empty or not found yet.');
                this.recordSnapshot(localDir);
                return;
            }
            throw new Error(result.stderr || `rclone copy exit ${result.code}`);
        }
        this.recordSnapshot(localDir);
    }

    /**
     * 작업 공간 폴더 감시 시작
     */
    startWatch(session) {
        this.stopWatch();
        this.sessionInfo = session;
        const localDir = session.localWorkspace;
        if (this.snapshotDir !== localDir) {
            this.recordSnapshot(localDir);
        }
        this.syncedRemoteFiles.clear();
        this.syncedRemoteDirs.clear();

        if (vscode && vscode.workspace && vscode.RelativePattern && vscode.Uri) {
            const pattern = new vscode.RelativePattern(vscode.Uri.file(localDir), '**/*');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate((uri) => this.enqueueChange('copy', uri.fsPath));
            watcher.onDidChange((uri) => this.enqueueChange('copy', uri.fsPath));
            watcher.onDidDelete((uri) => this.enqueueChange('delete', uri.fsPath));
            this.watcher = watcher;
        }

        try {
            const fsWatcher = fs.watch(localDir, { recursive: true }, (eventType, filename) => {
                if (!filename) {
                    return;
                }
                const fullPath = path.join(localDir, filename);
                const exists = fs.existsSync(fullPath);
                let action = exists ? 'copy' : 'delete';
                if (exists) {
                    try {
                        if (fs.statSync(fullPath).isDirectory()) {
                            action = 'mkdir';
                        }
                    } catch {
                        // The entry may disappear between the watch event and stat.
                    }
                }
                this.enqueueChange(action, fullPath);
            });
            fsWatcher.on('error', (error) => this.logger.warn(`Local workspace watcher failed: ${error.message}`));
            this.fsWatcher = fsWatcher;
        } catch (error) {
            this.logger.warn(`Could not watch local workspace recursively: ${error.message}`);
        }

        this.remoteScanTimer = setInterval(() => {
            this.syncRemoteChanges()
                .then(() => this.processQueue())
                .catch((error) => this.logger.warn(`Remote workspace sync failed: ${error.message}`));
        }, REMOTE_SCAN_INTERVAL_MS);
        this.syncRemoteChanges()
            .then(() => this.processQueue())
            .catch((error) => this.logger.warn(`Initial remote workspace scan failed: ${error.message}`));
        this.logger.info(`Syncer watching local workspace: ${localDir}`);
    }

    stopWatch() {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = undefined;
        }
        if (this.remoteScanTimer) {
            clearInterval(this.remoteScanTimer);
            this.remoteScanTimer = undefined;
        }
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }

    enqueueChange(action, filePath) {
        if (!this.sessionInfo) {
            return;
        }
        const relPosix = toRelativePosix(this.sessionInfo.localWorkspace, filePath);
        if (!relPosix || isExcluded(relPosix)) {
            return;
        }

        // 기존 디바운스 타이머 취소
        if (this.debounceTimers.has(relPosix)) {
            clearTimeout(this.debounceTimers.get(relPosix));
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(relPosix);
            // 디렉터리 생성인 경우 rclone copyfile이 아니라 디렉터리이므로 건너뜀
            if (action === 'copy' || action === 'mkdir') {
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.isDirectory()) {
                        action = 'mkdir';
                    } else if (action === 'mkdir') {
                        action = 'copy';
                    }
                    if (stat.isFile()) {
                        const sig = fileSignature(filePath);
                        if (sig && sameSignature(sig, this.syncedFiles.get(relPosix))) {
                            return;
                        }
                    }
                } catch {
                    // 파일이 잠깐 생겼다 지워진 경우
                    action = this.syncedDirs.has(relPosix) ? 'deleteDirectory' : 'delete';
                }
            } else if (action === 'delete' && this.syncedDirs.has(relPosix)) {
                action = 'deleteDirectory';
            }
            if (action === 'delete' && !this.syncedFiles.has(relPosix)) {
                return;
            }
            if (action === 'deleteDirectory' && !this.syncedDirs.has(relPosix)) {
                return;
            }
            this.queue.set(relPosix, { action, localPath: filePath, remoteRel: relPosix });
            this.notifyChange();
            this.processQueue();
        }, 200);

        this.debounceTimers.set(relPosix, timer);
    }

    async syncRemoteChanges() {
        if (this.disposed || !this.sessionInfo || this.remoteScanRunning) {
            return;
        }
        this.remoteScanRunning = true;
        try {
            const auth = await this.resolveSessionAuth();
            const target = {
                host: this.sessionInfo.host,
                port: this.sessionInfo.port,
                user: this.sessionInfo.user
            };
            const remoteFs = sftpConnectionString(target, auth, this.sessionInfo.remoteWorkspace);
            const localFs = this.sessionInfo.localWorkspace.replace(/\\/g, '/');
            const result = await this.rclone.call('operations/list', {
                fs: remoteFs,
                remote: '',
                opt: { recurse: true }
            }, 30000);
            if (!result || (!Array.isArray(result.list) && result.list !== null)) {
                throw new Error('The rclone response for the remote workspace listing was invalid.');
            }
            const entries = result.list || [];
            const remoteFiles = new Map();
            const remoteDirs = new Set();
            for (const entry of entries) {
                const rel = String(entry.Path || entry.Name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
                if (!rel) {
                    if (entry.IsDir) {
                        continue;
                    }
                    throw new Error('The rclone response contained a remote file without a path.');
                }
                if (typeof entry.IsDir !== 'boolean') {
                    throw new Error(`The rclone response contained an invalid entry for ${rel}.`);
                }
                if (isExcluded(rel)) {
                    continue;
                }
                if (entry.IsDir) {
                    remoteDirs.add(rel);
                } else {
                    const size = Number(entry.Size);
                    const mtimeMs = Date.parse(entry.ModTime);
                    if (!Number.isFinite(size) || size < 0 || !Number.isFinite(mtimeMs)) {
                        throw new Error(`The rclone response contained invalid metadata for ${rel}.`);
                    }
                    remoteFiles.set(rel, { size, mtimeMs });
                    const parts = rel.split('/');
                    for (let i = 1; i < parts.length; i++) {
                        remoteDirs.add(parts.slice(0, i).join('/'));
                    }
                }
            }

            if (this.syncedRemoteFiles.size === 0) {
                for (const [rel, signature] of remoteFiles) {
                    this.syncedRemoteFiles.set(rel, signature);
                    const localPath = path.join(this.sessionInfo.localWorkspace, ...rel.split('/'));
                    const localSignature = fileSignature(localPath);
                    const previousLocal = this.syncedFiles.get(rel);
                    if (!localSignature) {
                        await this.pullRemoteFile(remoteFs, localFs, rel, signature);
                    } else if (!previousLocal) {
                        if (localSignature.mtimeMs > signature.mtimeMs) {
                            this.queue.set(rel, { action: 'copy', localPath, remoteRel: rel });
                        } else {
                            await this.pullRemoteFile(remoteFs, localFs, rel, signature);
                        }
                    } else if (!sameSignature(localSignature, previousLocal) || localSignature.size !== signature.size) {
                        const localChanged = !sameSignature(localSignature, previousLocal);
                        if (localChanged && localSignature.mtimeMs > signature.mtimeMs) {
                            this.queue.set(rel, { action: 'copy', localPath, remoteRel: rel });
                        } else {
                            await this.pullRemoteFile(remoteFs, localFs, rel, signature);
                        }
                    }
                }
                for (const rel of remoteDirs) {
                    const queued = this.queue.get(rel);
                    if (!queued || queued.action !== 'deleteDirectory') {
                        this.ensureLocalDirectory(rel);
                    }
                    this.syncedRemoteDirs.add(rel);
                }
                this.notifyChange();
                return;
            }

            for (const [rel, remoteSignature] of remoteFiles) {
                const localPath = path.join(this.sessionInfo.localWorkspace, ...rel.split('/'));
                const localSignature = fileSignature(localPath);
                const previousRemote = this.syncedRemoteFiles.get(rel);
                const previousLocal = this.syncedFiles.get(rel);
                const remoteChanged = previousRemote && previousRemote.unverified
                    ? previousRemote.size !== remoteSignature.size
                    : !sameSignature(remoteSignature, previousRemote);
                const localChanged = !sameSignature(localSignature, previousLocal);

                if (remoteChanged && !localChanged) {
                    await this.pullRemoteFile(remoteFs, localFs, rel, remoteSignature);
                } else if (localChanged && (!remoteChanged || (localSignature && localSignature.mtimeMs > remoteSignature.mtimeMs))) {
                    this.queue.set(rel, { action: localSignature ? 'copy' : 'delete', localPath, remoteRel: rel });
                } else if (remoteChanged && localChanged) {
                    await this.pullRemoteFile(remoteFs, localFs, rel, remoteSignature);
                }
                this.syncedRemoteFiles.set(rel, remoteSignature);
            }

            for (const [rel] of Array.from(this.syncedRemoteFiles)) {
                if (remoteFiles.has(rel)) {
                    continue;
                }
                const localPath = path.join(this.sessionInfo.localWorkspace, ...rel.split('/'));
                const localSignature = fileSignature(localPath);
                const previousLocal = this.syncedFiles.get(rel);
                if (localSignature && !sameSignature(localSignature, previousLocal)) {
                    this.queue.set(rel, { action: 'copy', localPath, remoteRel: rel });
                } else {
                    try {
                        fs.unlinkSync(localPath);
                    } catch (error) {
                        if (error.code !== 'ENOENT') {
                            throw error;
                        }
                    }
                    this.syncedFiles.delete(rel);
                }
                this.syncedRemoteFiles.delete(rel);
            }

            for (const rel of remoteDirs) {
                const queued = this.queue.get(rel);
                if (!queued || queued.action !== 'deleteDirectory') {
                    this.ensureLocalDirectory(rel);
                }
                this.syncedRemoteDirs.add(rel);
            }
            for (const rel of Array.from(this.syncedRemoteDirs)) {
                if (!remoteDirs.has(rel)) {
                    const localPath = path.join(this.sessionInfo.localWorkspace, ...rel.split('/'));
                    const queued = this.queue.get(rel);
                    if (!queued || queued.action !== 'mkdir') {
                        if (this.localDirectoryHasChanges(rel)) {
                            this.queueLocalDirectory(rel);
                        } else {
                            try {
                                fs.rmSync(localPath, { recursive: true, force: true });
                            } catch (error) {
                                if (error.code !== 'ENOENT') {
                                    throw error;
                                }
                            }
                            this.syncedDirs.delete(rel);
                        }
                    }
                    this.syncedRemoteDirs.delete(rel);
                }
            }
            this.notifyChange();
        } finally {
            this.remoteScanRunning = false;
        }
    }

    ensureLocalDirectory(rel) {
        const localPath = path.join(this.sessionInfo.localWorkspace, ...rel.split('/'));
        fs.mkdirSync(localPath, { recursive: true });
        this.syncedDirs.add(rel);
    }

    localDirectoryHasChanges(rel) {
        const localRoot = this.sessionInfo.localWorkspace;
        const directory = path.join(localRoot, ...rel.split('/'));
        if (!fs.existsSync(directory)) {
            return false;
        }
        let changed = Array.from(this.queue.keys()).some((queued) => queued.startsWith(`${rel}/`));
        const seenFiles = new Set();
        const seenDirs = new Set();
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relative = toRelativePosix(localRoot, fullPath);
                if (!relative || isExcluded(relative)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    seenDirs.add(relative);
                    if (!this.syncedDirs.has(relative)) {
                        changed = true;
                    }
                    walk(fullPath);
                } else if (entry.isFile()) {
                    seenFiles.add(relative);
                    if (!sameSignature(fileSignature(fullPath), this.syncedFiles.get(relative))) {
                        changed = true;
                    }
                }
            }
        };
        walk(directory);
        for (const previous of this.syncedFiles.keys()) {
            if (previous.startsWith(`${rel}/`) && !seenFiles.has(previous)) {
                changed = true;
            }
        }
        for (const previous of this.syncedDirs) {
            if (previous.startsWith(`${rel}/`) && !seenDirs.has(previous)) {
                changed = true;
            }
        }
        return changed;
    }

    queueLocalDirectory(rel) {
        const localRoot = this.sessionInfo.localWorkspace;
        const directory = path.join(localRoot, ...rel.split('/'));
        const walk = (dir) => {
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relative = toRelativePosix(localRoot, fullPath);
                if (!relative || isExcluded(relative)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    this.queue.set(relative, { action: 'mkdir', localPath: fullPath, remoteRel: relative });
                    walk(fullPath);
                } else if (entry.isFile()) {
                    this.queue.set(relative, { action: 'copy', localPath: fullPath, remoteRel: relative });
                }
            }
        };
        this.queue.set(rel, { action: 'mkdir', localPath: directory, remoteRel: rel });
        walk(directory);
    }

    async statRemote(remoteFs, rel) {
        try {
            const result = await this.rclone.call('operations/stat', { fs: remoteFs, remote: rel }, 15000);
            const item = result && result.item;
            const size = item ? Number(item.Size) : NaN;
            const mtimeMs = item ? Date.parse(item.ModTime) : NaN;
            if (!item || item.IsDir || !Number.isFinite(size) || !Number.isFinite(mtimeMs)) {
                return undefined;
            }
            return { size, mtimeMs };
        } catch (error) {
            this.logger.debug(`stat after upload failed (${rel}): ${error.message}`);
            return undefined;
        }
    }

    async pullRemoteFile(remoteFs, localFs, rel, remoteSignature) {
        const localPath = path.join(this.sessionInfo.localWorkspace, ...rel.split('/'));
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        await this.rclone.call('operations/copyfile', {
            srcFs: remoteFs,
            srcRemote: rel,
            dstFs: localFs,
            dstRemote: rel,
            _config: { IgnoreTimes: true }
        }, 30000);
        const localSignature = fileSignature(localPath);
        if (localSignature) {
            this.syncedFiles.set(rel, localSignature);
        }
        this.syncedRemoteFiles.set(rel, remoteSignature);
        this.logger.debug(`Synced file from board: ${rel}`);
    }

    async resolveSessionAuth() {
        if (this.resolveAuth) {
            return this.resolveAuth(this.sessionInfo);
        }
        return {
            type: this.sessionInfo.authType,
            keyPath: this.sessionInfo.keyPath,
            obscured: this.sessionInfo.obscuredPassword
        };
    }

    async processQueue() {
        if (this.disposed || !this.sessionInfo || this.activeTransfers >= this.maxTransfers) {
            return;
        }

        const nextEntry = Array.from(this.queue.entries()).find(([rel]) => !this.activePaths.has(rel));
        if (!nextEntry) {
            if (this.activeTransfers > 0) {
                return;
            }
            if (this.activeTransfers === 0 && this.flushWaiters.length > 0) {
                const waiters = this.flushWaiters;
                this.flushWaiters = [];
                const ok = !this.lastError;
                waiters.forEach((resolve) => resolve(ok));
            }
            return;
        }

        const [relPosix, task] = nextEntry;
        if (task.action === 'deleteDirectory' && this.activeTransfers > 0) {
            return;
        }
        if (task.action === 'deleteDirectory') {
            for (const rel of Array.from(this.queue.keys())) {
                if (rel.startsWith(`${relPosix}/`)) {
                    this.queue.delete(rel);
                }
            }
            for (const [rel, timer] of Array.from(this.debounceTimers.entries())) {
                if (rel.startsWith(`${relPosix}/`)) {
                    clearTimeout(timer);
                    this.debounceTimers.delete(rel);
                }
            }
        }
        this.queue.delete(relPosix);
        this.activeTransfers++;
        this.activePaths.add(relPosix);
        this.notifyChange();

        const target = {
            host: this.sessionInfo.host,
            port: this.sessionInfo.port,
            user: this.sessionInfo.user
        };

        try {
            const auth = await this.resolveSessionAuth();
            const remoteFs = sftpConnectionString(target, auth, this.sessionInfo.remoteWorkspace);
            const localFs = this.sessionInfo.localWorkspace.replace(/\\/g, '/');

            if (task.action === 'copy') {
                const sig = fileSignature(task.localPath);
                if (sig) {
                    await this.rclone.call('operations/copyfile', {
                        srcFs: localFs,
                        srcRemote: task.remoteRel,
                        dstFs: remoteFs,
                        dstRemote: task.remoteRel,
                        _config: { IgnoreTimes: true }
                    }, 30000);
                    this.syncedFiles.set(task.remoteRel, fileSignature(task.localPath) || sig);
                    // SFTP keeps coarser mtimes than NTFS, so the baseline must come from the board itself.
                    const remoteSig = await this.statRemote(remoteFs, task.remoteRel);
                    if (remoteSig) {
                        this.syncedRemoteFiles.set(task.remoteRel, remoteSig);
                    } else {
                        this.syncedRemoteFiles.set(task.remoteRel, { size: sig.size, unverified: true });
                    }
                    this.lastError = undefined;
                    this.logger.debug(`Synced file to board: ${task.remoteRel}`);
                }
            } else if (task.action === 'delete') {
                await this.rclone.call('operations/deletefile', {
                    fs: remoteFs,
                    remote: task.remoteRel
                }, 15000);
                this.syncedFiles.delete(task.remoteRel);
                this.syncedRemoteFiles.delete(task.remoteRel);
                this.lastError = undefined;
                this.logger.debug(`Deleted remote file: ${task.remoteRel}`);
            } else if (task.action === 'mkdir') {
                await this.rclone.call('operations/mkdir', { fs: remoteFs, remote: task.remoteRel }, 15000);
                this.syncedDirs.add(task.remoteRel);
                this.syncedRemoteDirs.add(task.remoteRel);
                this.lastError = undefined;
                this.logger.debug(`Created remote directory: ${task.remoteRel}`);
            } else if (task.action === 'deleteDirectory') {
                await this.rclone.call('operations/purge', { fs: remoteFs, remote: task.remoteRel }, 30000);
                this.syncedDirs.delete(task.remoteRel);
                this.syncedRemoteDirs.delete(task.remoteRel);
                for (const rel of Array.from(this.syncedFiles.keys())) {
                    if (rel.startsWith(`${task.remoteRel}/`)) {
                        this.syncedFiles.delete(rel);
                        this.syncedRemoteFiles.delete(rel);
                        this.queue.delete(rel);
                    }
                }
                for (const rel of Array.from(this.syncedDirs)) {
                    if (rel.startsWith(`${task.remoteRel}/`)) {
                        this.syncedDirs.delete(rel);
                        this.syncedRemoteDirs.delete(rel);
                        this.queue.delete(rel);
                    }
                }
                this.lastError = undefined;
                this.logger.debug(`Deleted remote directory: ${task.remoteRel}`);
            }
        } catch (error) {
            this.lastError = error;
            this.logger.warn(`Sync failed for ${task.remoteRel} (${task.action}): ${error.message}`);
        } finally {
            this.activeTransfers--;
            this.activePaths.delete(relPosix);
            const queued = this.queue.get(relPosix);
            if (queued && (
                (queued.action === 'copy' && sameSignature(fileSignature(queued.localPath), this.syncedFiles.get(relPosix))
                    && !this.syncedDirs.has(relPosix))
                || (queued.action === 'delete' && !fileSignature(queued.localPath) && !this.syncedFiles.has(relPosix))
                || (queued.action === 'mkdir' && this.syncedDirs.has(relPosix))
                || (queued.action === 'deleteDirectory' && !this.syncedDirs.has(relPosix))
            )) {
                this.queue.delete(relPosix);
            }
            this.notifyChange();
            this.processQueue();
        }
    }

    /**
     * 대기 중인 모든 업로드가 완료될 때까지 기다림
     */
    async flush(timeoutMs = 15000, options = {}) {
        if (!this.sessionInfo) {
            return true;
        }
        if (options.scan !== false) {
            try {
                await this.syncRemoteChanges();
            } catch (error) {
                this.lastError = error;
                this.logger.warn(`Final remote sync scan failed: ${error.message}`);
            }
        }
        // 남은 디바운스 타이머 즉시 실행
        for (const [relPosix, timer] of Array.from(this.debounceTimers.entries())) {
            clearTimeout(timer);
            this.debounceTimers.delete(relPosix);
            const filePath = path.join(this.sessionInfo.localWorkspace, ...relPosix.split('/'));
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    if (!this.syncedDirs.has(relPosix)) {
                        this.queue.set(relPosix, { action: 'mkdir', localPath: filePath, remoteRel: relPosix });
                    }
                } else if (stat.isFile()) {
                    const sig = fileSignature(filePath);
                    if (sig && !sameSignature(sig, this.syncedFiles.get(relPosix))) {
                        this.queue.set(relPosix, { action: 'copy', localPath: filePath, remoteRel: relPosix });
                    }
                }
            } catch {
                if (this.syncedDirs.has(relPosix)) {
                    this.queue.set(relPosix, { action: 'deleteDirectory', localPath: filePath, remoteRel: relPosix });
                } else if (this.syncedFiles.has(relPosix)) {
                    this.queue.set(relPosix, { action: 'delete', localPath: filePath, remoteRel: relPosix });
                }
            }
        }

        // 파일 감시 이벤트가 도착하기 전 변경된 파일도 스캔해 대기열에 추가
        if (options.scan !== false) {
            this.scanChanges();
        }

        if (this.queue.size === 0 && this.activeTransfers === 0) {
            return true;
        }

        this.lastError = undefined;
        this.notifyChange();
        this.processQueue();

        return new Promise((resolve) => {
            let timer;
            const onDone = (ok) => {
                clearTimeout(timer);
                resolve(ok);
            };
            timer = setTimeout(() => {
                const idx = this.flushWaiters.indexOf(onDone);
                if (idx >= 0) {
                    this.flushWaiters.splice(idx, 1);
                }
                resolve(false);
            }, timeoutMs);

            this.flushWaiters.push(onDone);
        });
    }

    dispose() {
        this.disposed = true;
        this.stopWatch();
        this.queue.clear();
        this.syncedFiles.clear();
        this.syncedRemoteFiles.clear();
        this.syncedDirs.clear();
        this.syncedRemoteDirs.clear();
        this.emitter.dispose();
    }
}

module.exports = { Syncer, toRelativePosix, isExcluded, DEFAULT_EXCLUDES };
