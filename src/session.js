'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const {
    readJson, writeJson, removeFile, isProcessAlive, samePath, sleep, probeTcp, normalizeDriveLetter, writeIfChanged
} = require('./util');
const { sftpConnectionString } = require('./rclone');
const { buildWorkspace, sshTerminalArgs } = require('./workspaceFile');
const { buildSshTerminalScript } = require('./sshTerminal');
const { isAuthError } = require('./auth');
const { getSettings, validateSettings, targetOf } = require('./settings');
const pyLibs = require('./pyLibs');
const { obscure } = require('./obscure');
const { t } = require('./i18n');

const HEARTBEAT_MS = 10000;
const OWNER_STALE_MS = 35000;
const STATUS_INTERVAL_MS = 5000;
const WATCHDOG_INTERVAL_MS = 15000;
const AUTO_RELOAD_GUARD_MS = 60000;
const LIBRARY_SYNC_DELAY_MS = 15000;

function busyLabel(phase) {
    switch (phase) {
        case 'opening':
            return t('opening the remote workspace');
        case 'closing':
            return t('closing the remote workspace');
        case 'reconnecting':
            return t('reconnecting');
        default:
            return phase;
    }
}

class SessionManager {
    /**
     * @param {{context: vscode.ExtensionContext, log: vscode.LogOutputChannel, ssh: any, rclone: any,
     *          auth: any, prereq: any, storageDir: string}} services
     */
    constructor(services) {
        Object.assign(this, services);
        this.workspaceFile = path.join(this.storageDir, 'tOS.code-workspace');
        this.sessionFile = path.join(this.storageDir, 'session.json');
        this.ownerFile = path.join(this.storageDir, 'owner.json');
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
        this.busy = undefined;
        this.libSyncRunning = false;
        this.cachedSession = this.readSession();
        this.status = { phase: 'idle', session: this.cachedSession, mounted: false, pendingUploads: 0, daemon: false };
        this.disposed = false;
        this.closeRequested = false;
        this.watchdogFailures = 0;
        this.onBeforeClose = undefined;
    }

    // ---------------------------------------------------------------- 상태 파일

    readSession() {
        return readJson(this.sessionFile);
    }

    writeSession(session) {
        writeJson(this.sessionFile, session);
        this.cachedSession = session;
    }

    /** 현재 세션의 일부 항목만 바꾼다. identity를 주면 같은 보드 세션일 때만 바꾼다. */
    updateSession(patch, identity) {
        const current = this.readSession();
        if (!current || (identity && current.identity !== identity)) {
            return undefined;
        }
        const next = { ...current, ...patch };
        this.writeSession(next);
        return next;
    }

    clearSession() {
        removeFile(this.sessionFile);
        this.cachedSession = undefined;
    }

    isOwnerWindow() {
        const file = vscode.workspace.workspaceFile;
        return !!file && file.scheme === 'file' && samePath(file.fsPath, this.workspaceFile);
    }

    otherOwnerAlive() {
        const owner = readJson(this.ownerFile);
        return !!owner && owner.pid !== process.pid && isProcessAlive(owner.pid) && Date.now() - owner.heartbeat < OWNER_STALE_MS;
    }

    startHeartbeat() {
        const beat = () => {
            try {
                writeJson(this.ownerFile, { pid: process.pid, heartbeat: Date.now() });
            } catch (error) {
                this.log.warn(`Failed to write heartbeat: ${error.message}`);
            }
        };
        beat();
        this.heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    }

    setBusy(value) {
        this.busy = value;
        this.status = { ...this.status, phase: this.computePhase(this.status) };
        this.emitter.fire(this.status);
    }

    computePhase(status) {
        if (this.busy) {
            return this.busy;
        }
        if (this.isOwnerWindow()) {
            return 'open';
        }
        if (status.session) {
            if (this.otherOwnerAlive()) {
                return 'elsewhere';
            }
            if (status.mounted) {
                return 'detached';
            }
        }
        return 'idle';
    }

    async refreshStatus() {
        const session = this.readSession();
        this.cachedSession = session;
        let daemon = false;
        let mounted = false;
        let pendingUploads = 0;
        if (session || this.rclone.readState()) {
            daemon = await this.rclone.isDaemonAlive();
            if (daemon && session) {
                mounted = await this.rclone.isMounted(session.drive);
                if (mounted) {
                    pendingUploads = await this.rclone.pendingUploads();
                }
            }
        }
        const status = { session, daemon, mounted, pendingUploads, libSyncRunning: this.libSyncRunning };
        status.phase = this.computePhase(status);
        this.status = status;
        vscode.commands.executeCommand('setContext', 'tosRemote.mounted', mounted);
        this.emitter.fire(status);
        return status;
    }

    showBusy() {
        vscode.window.showInformationMessage(t('Another operation is in progress ({0}).', busyLabel(this.busy)));
    }

    // ---------------------------------------------------------------- 초기화

    async initialize() {
        vscode.commands.executeCommand('setContext', 'tosRemote.workspaceOpen', this.isOwnerWindow());
        try {
            if (this.isOwnerWindow()) {
                await this.attach();
            } else {
                await this.resumePendingClose();
            }
        } catch (error) {
            this.log.error(`Initialization error: ${error.stack || error.message}`);
        }
        await this.refreshStatus();
        this.statusTimer = setInterval(() => {
            this.refreshStatus().catch((error) => this.log.debug(`Status refresh error: ${error.message}`));
        }, STATUS_INTERVAL_MS);
    }

    // 원격 작업 공간을 닫으면 창이 빈 창으로 다시 로드되며, 이때 마운트 해제를 마무리한다
    async resumePendingClose() {
        for (let i = 0; i < 4; i++) {
            const session = this.readSession();
            if (!session || session.state !== 'closing') {
                return;
            }
            if (!this.otherOwnerAlive()) {
                await this.finishClose();
                return;
            }
            await sleep(3000);
        }
    }

    // 원격 작업 공간 창이 열렸을 때 (작업 공간 열기 직후 또는 VS Code 재시작으로 복원된 경우)
    async attach() {
        this.startHeartbeat();
        let session = this.readSession();
        if (session && session.state === 'closing') {
            session = { ...session, state: 'open' };
            this.writeSession(session);
        }

        const mounted = !!session && (await this.rclone.isDaemonAlive()) && (await this.rclone.isMounted(session.drive));
        if (!mounted) {
            const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
            const folderDrive = folder ? normalizeDriveLetter(folder.uri.fsPath.slice(0, 2)) : '';
            this.setBusy('reconnecting');
            try {
                session = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('Reconnecting to the remote workspace')
                }, (progress) => this.connect(getSettings(), session, progress, { interactive: true, preferredDrive: folderDrive }));
            } catch (error) {
                this.setBusy(undefined);
                const retry = t('Retry');
                const closeWorkspace = t('Close Workspace');
                const pick = await this.reportError(t('Could not reconnect to the remote workspace.'), error, [retry, closeWorkspace]);
                if (pick === retry) {
                    clearInterval(this.heartbeatTimer);
                    return this.attach();
                }
                if (pick === closeWorkspace) {
                    return this.close();
                }
                return undefined;
            }
            this.setBusy(undefined);

            // 마운트 전에 시작된 탐색기·Pylance·터미널 설정을 새로 반영하기 위해 한 번 다시 로드
            const last = this.context.globalState.get('tosRemote.lastAutoReload') || 0;
            if (Date.now() - last > AUTO_RELOAD_GUARD_MS) {
                await this.context.globalState.update('tosRemote.lastAutoReload', Date.now());
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return undefined;
            }
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        }

        // 확장 업데이트·표시 언어 변경을 반영하도록 작업 공간 파일을 갱신(내용이 같으면 쓰지 않음)
        this.writeWorkspaceFile(session);
        this.startWatchdog();
        // 창이 열릴 때 터미널 SSH 접속과 겹치지 않도록 라이브러리 동기화는 잠시 뒤에 시작한다
        this.librarySyncTimer = setTimeout(() => {
            if (!this.disposed) {
                this.syncMissingLibraries(session);
            }
        }, LIBRARY_SYNC_DELAY_MS);
        if (session.authType === 'password') {
            this.suggestKeySetup();
        }
        return undefined;
    }

    async suggestKeySetup() {
        const register = t('Register SSH Key');
        const pick = await vscode.window.showInformationMessage(
            t('Connected with a password. Register an SSH key to open the terminal and run programs without entering the password.'),
            register
        );
        if (pick === register) {
            await vscode.commands.executeCommand('tosRemote.setupSshKey');
        }
    }

    // ---------------------------------------------------------------- 열기

    async open() {
        if (this.busy) {
            this.showBusy();
            return;
        }
        if (this.isOwnerWindow()) {
            if (await this.rclone.isMounted(this.readSession() && this.readSession().drive)) {
                vscode.window.showInformationMessage(t('The remote workspace is already open.'));
            } else {
                await this.recover(this.readSession(), true);
            }
            return;
        }
        const previous = this.readSession();
        if (previous && this.otherOwnerAlive()) {
            // 이미 열린 창으로 이동 (원격 작업 공간은 한 창에서만 연다)
            await this.openWorkspaceWindow();
            return;
        }
        const settings = getSettings();
        const invalid = validateSettings(settings);
        if (invalid) {
            const openSettings = t('Open Board Settings');
            const pick = await vscode.window.showErrorMessage(invalid, openSettings);
            if (pick === openSettings) {
                await vscode.commands.executeCommand('tosRemote.panel.focus');
            }
            return;
        }

        this.setBusy('opening');
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Opening the remote workspace')
            }, (progress) => this.connect(settings, previous, progress, { interactive: true }));
        } catch (error) {
            this.setBusy(undefined);
            await this.reportError(t('Could not open the remote workspace.'), error);
            await this.refreshStatus();
            return;
        }
        this.setBusy(undefined);
        await this.openWorkspaceWindow();
    }

    openWorkspaceWindow() {
        return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.workspaceFile), { forceNewWindow: false });
    }

    pickDrive(configured, preferred) {
        const inUse = (drive) => fs.existsSync(`${drive}\\`);
        if (configured) {
            if (inUse(configured)) {
                throw new Error(t('Drive {0} is already in use. Choose another drive in the panel or set it to Auto.', configured));
            }
            return configured;
        }
        if (preferred && !inUse(preferred)) {
            return preferred;
        }
        for (let code = 'Z'.charCodeAt(0); code >= 'D'.charCodeAt(0); code--) {
            const drive = `${String.fromCharCode(code)}:`;
            if (!inUse(drive)) {
                return drive;
            }
        }
        throw new Error(t('No drive letter is available.'));
    }

    /**
     * 보드 접속 → rclone 데몬 → 마운트 → 작업 공간 파일 생성까지 수행하고 세션을 기록한다.
     */
    async connect(settings, previous, progress, options = {}) {
        const report = (message) => progress.report({ message });
        const target = targetOf(settings);
        const identity = `${target.user}@${target.host}:${target.port}${settings.remoteWorkspace}`;
        const sameIdentity = !!previous && previous.identity === identity;

        report(t('Checking prerequisites'));
        await this.prereq.ensureAll({ interactive: options.interactive });

        report(t('Checking {0}', `${target.host}:${target.port}`));
        const probe = await probeTcp(target.host, target.port, 5000);
        if (!probe.ok) {
            throw new Error(t('Cannot connect to the board ({0}): {1}', `${target.host}:${target.port}`, probe.error));
        }
        this.ssh.resetKnownHosts();

        report(t('Checking authentication'));
        const auth = await this.auth.resolve(settings, target, { interactive: options.interactive });

        report(t('Starting rclone'));
        await this.rclone.ensureDaemon();

        const fsString = sftpConnectionString(target, auth, settings.remoteWorkspace);
        report(t('Checking the remote workspace'));
        try {
            // 작업 공간 폴더가 없으면 홈(/home/<user>) 아래에 만든다 (중간 폴더 포함)
            const exists = await this.rclone.dirExists(sftpConnectionString(target, auth, settings.homeDir), settings.workspaceFolder);
            if (exists === false) {
                report(t('Creating the remote workspace {0}', settings.remoteWorkspace));
            }
            await this.rclone.mkdir(fsString);
            if (exists === false) {
                this.log.info(`Created remote workspace: ${settings.remoteWorkspace}`);
            }
        } catch (error) {
            if (auth.type === 'password' && isAuthError(error.message)) {
                await this.auth.clearPassword(target);
                throw new Error(t('The password is incorrect. Please try again.'));
            }
            if (/permission denied/i.test(error.message)) {
                throw new Error(t('Could not create the remote workspace {0}: permission denied.', settings.remoteWorkspace));
            }
            throw error;
        }

        let drive;
        const mounts = await this.rclone.listMounts();
        const reusable = sameIdentity && previous.drive
            && mounts.some((m) => String(m.MountPoint).toUpperCase() === previous.drive.toUpperCase());
        if (reusable) {
            drive = previous.drive;
        } else {
            for (const m of mounts) {
                await this.waitForUploads(30000);
                await this.rclone.unmount(m.MountPoint);
            }
            drive = this.pickDrive(settings.driveLetter, options.preferredDrive || (previous && previous.drive));
            report(t('Mounting drive {0}', drive));
            await this.rclone.mount(fsString, drive);
            this.log.info(`Mounted ${identity} → ${drive}`);
        }

        const { libraries, aliases, tools } = await this.resolveLibraries(settings, target, auth, previous, sameIdentity, options, report);
        const kept = sameIdentity && previous ? previous : {};

        const session = {
            state: 'open',
            identity,
            host: target.host,
            port: target.port,
            user: target.user,
            remoteWorkspace: settings.remoteWorkspace,
            drive,
            authType: auth.type,
            keyPath: auth.type === 'key' ? auth.keyPath : undefined,
            pythonCommand: settings.pythonCommand,
            debugPort: settings.debugPort,
            libraries,
            libraryAliases: aliases,
            // 보드 도구(debugpy·Jupyter) 확인 결과와 실행 중인 Jupyter 서버 정보는 같은 보드로 다시 연결해도 유지한다
            boardTools: tools ? { probe: tools, checkedAt: Date.now() } : kept.boardTools,
            jupyter: kept.jupyter,
            openedAt: Date.now()
        };
        this.writeWorkspaceFile(session);
        this.writeSession(session);
        return session;
    }

    /**
     * IntelliSense용 보드 Python 라이브러리 경로 결정.
     * 사용자 지정(필수) > 보드 자동 감지(전역 필수, ~/.local·가상 환경 선택) > 이전 세션 > 문서 기준 기본값
     */
    async resolveLibraries(settings, target, auth, previous, sameIdentity, options = {}, report = () => {}) {
        if (settings.pythonLibraryPaths.length) {
            return { libraries: settings.pythonLibraryPaths.map((remote) => ({ remote, kind: 'custom' })), aliases: [] };
        }
        const previousLibraries = sameIdentity ? pyLibs.sessionLibraries(previous) : [];
        if (options.quick && previousLibraries.length) {
            return { libraries: previousLibraries, aliases: previous.libraryAliases || [] };
        }
        const password = auth.type === 'key' ? undefined : await this.auth.getPassword(target);
        const sshAuth = auth.type === 'key' ? { keyPath: auth.keyPath } : password ? { password } : undefined;
        if (sshAuth) {
            report(t('Detecting Python library paths'));
            const detected = await pyLibs.detectRemoteLibraries(this.ssh, target, sshAuth, settings.pythonCommand, settings.remoteWorkspace, this.log);
            if (detected) {
                return detected;
            }
        }
        if (previousLibraries.length) {
            return { libraries: previousLibraries, aliases: previous.libraryAliases || [] };
        }
        return { libraries: pyLibs.defaultLibraries(target.user), aliases: [] };
    }

    writeWorkspaceFile(session) {
        const target = { host: session.host, port: session.port, user: session.user };
        const sshArgs = this.ssh.baseArgs(target, { keyPath: session.authType === 'key' ? session.keyPath : undefined });

        // SSH 터미널은 cmd 배치 파일로 실행한다 (연결 실패 재시도, 종료 코드 알림 방지)
        const terminalScript = path.join(this.storageDir, 'ssh-terminal.cmd');
        const script = buildSshTerminalScript(this.ssh.sshPath, sshTerminalArgs(sshArgs, target, session.remoteWorkspace));
        writeIfChanged(terminalScript, script);

        const content = JSON.stringify(buildWorkspace({
            drive: session.drive,
            target,
            remoteWorkspace: session.remoteWorkspace,
            sshPath: this.ssh.sshPath,
            sshArgs,
            terminal: {
                path: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
                args: ['/d', '/c', terminalScript]
            },
            libraryCachePaths: pyLibs.sessionLibraries(session).map((library) => pyLibs.localCachePath(library.remote))
        }), null, 4);
        writeIfChanged(this.workspaceFile, content);
    }

    // ---------------------------------------------------------------- 연결 감시

    startWatchdog() {
        const tick = async () => {
            if (this.disposed) {
                return;
            }
            let delay = WATCHDOG_INTERVAL_MS;
            const session = this.readSession();
            if (!this.busy && session && session.state === 'open') {
                const ok = (await this.rclone.isDaemonAlive()) && (await this.rclone.isMounted(session.drive));
                if (!ok) {
                    delay = await this.recover(session, false);
                } else {
                    this.watchdogFailures = 0;
                }
            }
            if (!this.disposed) {
                this.watchdogTimer = setTimeout(tick, delay);
            }
        };
        this.watchdogTimer = setTimeout(tick, WATCHDOG_INTERVAL_MS);
    }

    async recover(session, interactive) {
        this.log.warn('Mount lost. Reconnecting...');
        this.setBusy('reconnecting');
        try {
            const updated = await this.connect(getSettings(), session, { report() {} }, {
                interactive,
                quick: true,
                preferredDrive: session && session.drive
            });
            this.watchdogFailures = 0;
            this.log.info(`Reconnected (${updated.drive})`);
            if (session && updated.drive !== session.drive) {
                const reload = t('Reload Window');
                const pick = await vscode.window.showWarningMessage(
                    t('The drive changed from {0} to {1}. The window must be reloaded.', session.drive, updated.drive),
                    reload
                );
                if (pick === reload) {
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            } else {
                await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            }
            return WATCHDOG_INTERVAL_MS;
        } catch (error) {
            this.watchdogFailures++;
            this.log.warn(`Reconnect failed (attempt ${this.watchdogFailures}): ${error.message}`);
            if (this.watchdogFailures === 3 || interactive) {
                this.reportError(t('The connection to the board was lost. Retrying automatically.'), error);
            }
            return Math.min(60000, 5000 * 2 ** this.watchdogFailures);
        } finally {
            this.setBusy(undefined);
            this.refreshStatus().catch(() => {});
        }
    }

    // ---------------------------------------------------------------- 닫기

    async close() {
        if (this.busy && this.busy !== 'reconnecting') {
            this.showBusy();
            return;
        }
        const session = this.readSession();
        if (this.isOwnerWindow()) {
            if (this.onBeforeClose) {
                await this.onBeforeClose();
            }
            if (session) {
                this.writeSession({ ...session, state: 'closing' });
            }
            this.closeRequested = true;
            this.setBusy('closing');
            // 저장 확인 대화 상자에서 취소하면 창이 그대로 남으므로 상태를 되돌린다
            setTimeout(() => {
                if (this.disposed || !this.closeRequested) {
                    return;
                }
                this.closeRequested = false;
                const current = this.readSession();
                if (current && current.state === 'closing') {
                    this.writeSession({ ...current, state: 'open' });
                }
                this.setBusy(undefined);
            }, 15000);
            // 작업 공간을 먼저 닫고(창 재로드) 빈 창에서 마운트를 해제해야 열린 편집기·Pylance 오류가 생기지 않는다
            await vscode.commands.executeCommand('workbench.action.closeFolder');
            return;
        }
        if (session && this.otherOwnerAlive()) {
            const goTo = t('Go to That Window');
            const pick = await vscode.window.showInformationMessage(t('The remote workspace is open in another window. Close it from that window.'), goTo);
            if (pick === goTo) {
                await this.openWorkspaceWindow();
            }
            return;
        }
        if (!session && !(await this.rclone.isDaemonAlive())) {
            vscode.window.showInformationMessage(t('No remote workspace is open.'));
            return;
        }
        await this.finishClose();
    }

    async finishClose() {
        this.setBusy('closing');
        const uploading = (count) => t('Uploading to the board... ({0} remaining)', count);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Closing the remote workspace')
            }, async (progress) => {
                if (await this.rclone.isDaemonAlive()) {
                    let flushed = await this.waitForUploads(60000, (count) => progress.report({ message: uploading(count) }));
                    const keepWaiting = t('Keep Waiting');
                    const forceClose = t('Close Anyway');
                    while (!flushed) {
                        const count = await this.rclone.pendingUploads();
                        const pick = await vscode.window.showWarningMessage(
                            t('{0} file(s) have not been uploaded to the board yet. Closing now may lose your changes.', count),
                            { modal: true },
                            keepWaiting,
                            forceClose
                        );
                        if (pick === keepWaiting) {
                            flushed = await this.waitForUploads(60000, (n) => progress.report({ message: uploading(n) }));
                        } else if (pick === forceClose) {
                            this.log.warn(`Closing with ${count} pending upload(s)`);
                            break;
                        } else {
                            throw new Error(t('Close was canceled.'));
                        }
                    }
                    progress.report({ message: t('Unmounting') });
                    for (const m of await this.rclone.listMounts()) {
                        await this.rclone.unmount(m.MountPoint);
                    }
                }
                await this.rclone.quitDaemon();
            });
            this.clearSession();
            this.log.info('Remote workspace closed');
            vscode.window.setStatusBarMessage(t('tOS: Remote workspace closed.'), 5000);
        } catch (error) {
            const session = this.readSession();
            if (session && session.state === 'closing') {
                this.writeSession({ ...session, state: 'open' });
            }
            await this.reportError(t('Could not finish closing the remote workspace.'), error);
        } finally {
            this.setBusy(undefined);
            await this.refreshStatus();
        }
    }

    /** VFS 쓰기 대기열이 빌 때까지 기다린다. @returns {Promise<boolean>} 모두 업로드되었는지 */
    async waitForUploads(timeoutMs, onPending) {
        const start = Date.now();
        // WinFsp는 파일 닫기를 rclone에 비동기로 전달하므로, 저장 직후에는 대기열이 잠시 비어 보일 수 있다.
        // 잠깐 기다린 뒤 연속 두 번 비어 있을 때만 완료로 본다.
        await sleep(300);
        let emptyChecks = 0;
        for (;;) {
            const count = await this.rclone.pendingUploads();
            if (count === 0) {
                emptyChecks++;
                if (emptyChecks >= 2) {
                    return true;
                }
            } else {
                emptyChecks = 0;
                if (onPending) {
                    onPending(count);
                }
            }
            if (Date.now() - start > timeoutMs) {
                return false;
            }
            await sleep(300);
        }
    }

    // ---------------------------------------------------------------- 기타 기능

    syncMissingLibraries(session) {
        const missing = pyLibs.sessionLibraries(session).filter((library) => !pyLibs.hasCache(pyLibs.localCachePath(library.remote)));
        if (missing.length) {
            this.syncLibraries(missing, false);
        }
    }

    async resolveSessionAuth(session) {
        if (session.authType === 'key' && session.keyPath) {
            return { type: 'key', keyPath: session.keyPath };
        }
        const password = await this.auth.getPassword({ host: session.host, port: session.port, user: session.user });
        if (!password) {
            throw new Error(t('No password is saved.'));
        }
        return { type: 'password', obscured: obscure(password) };
    }

    /**
     * 화면 없이 실행하는 ssh(원격 명령·디버그·Jupyter)용 인증. 키 인증이 아니면 저장된 비밀번호를 SSH_ASKPASS로 넘긴다.
     * @param {{interactive?: boolean}} options interactive면 저장된 비밀번호가 없을 때 입력받는다
     * @returns {Promise<{keyPath: string} | {password: string}>}
     */
    async sshAuth(session, options = {}) {
        if (session.authType === 'key' && session.keyPath) {
            return { keyPath: session.keyPath };
        }
        const target = { host: session.host, port: session.port, user: session.user };
        let password = await this.auth.getPassword(target);
        if (!password && options.interactive) {
            password = await this.auth.promptPassword(target);
        }
        if (!password) {
            throw new Error(t('No password is saved. Save the board password in the panel or register an SSH key.'));
        }
        return { password };
    }

    /**
     * @param {{remote: string, kind: string}[]|undefined} libraries 동기화할 라이브러리. 비우면(수동 동기화) 보드에서 다시 감지해 전체를 동기화한다.
     * @param {boolean} notify 완료 알림 표시 여부 (수동 동기화)
     * 필수 경로(전역·사용자 지정)의 실패만 알림창으로 표시하고, 선택 경로(~/.local·가상 환경)는 없거나 실패해도 로그만 남긴다.
     */
    async syncLibraries(libraries, notify) {
        let session = this.readSession();
        if (!session) {
            vscode.window.showInformationMessage(t('Open the remote workspace first.'));
            return;
        }
        if (this.libSyncRunning) {
            if (notify) {
                vscode.window.showInformationMessage(t('Python library sync is already running.'));
            }
            return;
        }
        const target = { host: session.host, port: session.port, user: session.user };
        this.libSyncRunning = true;
        this.emitter.fire({ ...this.status, libSyncRunning: true });
        const done = [];
        const skipped = [];
        const failedRequired = [];
        try {
            const auth = await this.resolveSessionAuth(session);

            // 수동 동기화: 작업 중 새로 만든 가상 환경(uv venv 등)을 반영하기 위해 경로를 다시 감지한다
            if (!libraries && !getSettings().pythonLibraryPaths.length) {
                const sshAuth = await this.sshAuth(session).catch(() => undefined);
                const detected = sshAuth
                    && await pyLibs.detectRemoteLibraries(this.ssh, target, sshAuth, session.pythonCommand || 'python3', session.remoteWorkspace, this.log);
                const current = this.readSession();
                if (detected && current && current.identity === session.identity) {
                    session = { ...current, libraries: detected.libraries, libraryAliases: detected.aliases };
                    if (detected.tools) {
                        session.boardTools = { probe: detected.tools, checkedAt: Date.now() };
                    }
                    delete session.libraryPaths;
                    this.writeSession(session);
                    if (this.isOwnerWindow()) {
                        this.writeWorkspaceFile(session);
                    }
                    this.emitter.fire({ ...this.status, session, libSyncRunning: true });
                }
            }
            const targets = libraries || pyLibs.sessionLibraries(session);

            await vscode.window.withProgress({
                location: notify ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
                title: t('Syncing Python libraries')
            }, async (progress) => {
                for (const library of targets) {
                    const required = pyLibs.isRequired(library);
                    const name = library.remote.split('/').slice(-4).join('/');
                    progress.report({ message: name });
                    try {
                        const local = await pyLibs.syncLibrary(this.rclone, target, auth, library.remote, (line) => progress.report({ message: `${name} · ${line}` }));
                        if (local) {
                            done.push(library);
                            this.log.info(`Library synced [${library.kind}]: ${library.remote}`);
                        } else if (required) {
                            failedRequired.push(library);
                            this.log.warn(`Required library path not found on the board [${library.kind}]: ${library.remote}`);
                        } else {
                            skipped.push(library);
                            this.log.info(`Optional library path not found on the board, skipped [${library.kind}]: ${library.remote}`);
                        }
                    } catch (error) {
                        if (required) {
                            failedRequired.push(library);
                        } else {
                            skipped.push(library);
                        }
                        this.log.warn(`Library sync failed [${library.kind}, ${required ? 'required' : 'optional'}] ${library.remote}: ${error.message}`);
                    }
                }
            });
        } catch (error) {
            this.log.warn(`Library sync error: ${error.message}`);
            failedRequired.push({ remote: error.message, kind: 'error' });
        } finally {
            this.libSyncRunning = false;
            this.emitter.fire({ ...this.status, libSyncRunning: false });
        }
        if (done.length && this.isOwnerWindow()) {
            vscode.commands.executeCommand('python.analysis.restartLanguageServer').then(undefined, () => {});
        }
        if (failedRequired.length) {
            const showLog = t('Show Log');
            const pick = await vscode.window.showWarningMessage(
                t('Failed to sync {0} required Python library path(s) ({1} synced). Check the log.', failedRequired.length, done.length),
                showLog
            );
            if (pick === showLog) {
                this.log.show();
            }
        } else if (notify) {
            vscode.window.showInformationMessage(skipped.length
                ? t('Python libraries synced ({0}). Skipped {1} optional path(s).', done.length, skipped.length)
                : t('Python libraries synced ({0}).', done.length));
        }
    }

    async refreshDrive() {
        if (!(await this.rclone.isDaemonAlive())) {
            vscode.window.showInformationMessage(t('No drive is mounted.'));
            return;
        }
        await this.rclone.refresh();
        await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        vscode.window.setStatusBarMessage(t('tOS: Drive refreshed.'), 3000);
    }

    /** 터미널 링크·디버그 경로 매핑용 (원격 경로 → 로컬 경로) */
    getPathMappings() {
        const session = this.cachedSession;
        if (!session || !session.drive) {
            return [];
        }
        return [
            { remote: session.remoteWorkspace, local: `${session.drive}\\` },
            ...pyLibs.sessionLibraries(session).map((library) => ({ remote: library.remote, local: pyLibs.localCachePath(library.remote) })),
            ...(session.libraryAliases || []).map((alias) => ({ remote: alias.remote, local: pyLibs.localCachePath(alias.real) }))
        ];
    }

    async reportError(title, error, actions = []) {
        const message = error && error.message ? error.message : String(error);
        this.log.error(`${title} ${message}`);
        const showLog = t('Show Log');
        const pick = await vscode.window.showErrorMessage(`${title}\n${message}`, ...actions, showLog);
        if (pick === showLog) {
            this.log.show();
        }
        return pick;
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        clearInterval(this.statusTimer);
        clearInterval(this.heartbeatTimer);
        clearTimeout(this.watchdogTimer);
        clearTimeout(this.librarySyncTimer);
        const owner = readJson(this.ownerFile);
        if (owner && owner.pid === process.pid) {
            removeFile(this.ownerFile);
        }
        this.emitter.dispose();
    }
}

module.exports = { SessionManager };
