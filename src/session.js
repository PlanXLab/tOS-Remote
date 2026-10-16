'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const {
    readJson, writeJson, removeFile, isProcessAlive, samePath, sleep, probeTcp, normalizeDriveLetter, writeIfChanged
} = require('./util');
const { sftpConnectionString } = require('./rclone');
const { buildWorkspace, sshTerminalArgs } = require('./workspaceFile');
const { buildSshTerminalScript, terminalScriptPath, terminalShellLaunch } = require('./sshTerminal');
const { isAuthError } = require('./auth');
const { getSettings, validateSettings, targetOf } = require('./settings');
const pyLibs = require('./pyLibs');
const { obscure } = require('./obscure');
const { Syncer } = require('./syncer');
const { RemoteTerminalGuard } = require('./remoteTerminal');
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
        this.statusRefreshId = 0;
        this.disposed = false;
        this.closeRequested = false;
        this.closeTimer = undefined;
        this.sharedStateWatcher = undefined;
        this.workspaceChangeListener = undefined;
        this.watchdogFailures = 0;
        this.onBeforeClose = undefined;
        this.syncer = new Syncer({
            rclone: this.rclone,
            resolveAuth: (session) => this.resolveSessionAuth(session),
            logger: this.log
        });
        this.syncer.onDidChange(() => this.refreshStatus().catch(() => {}));
        this.terminalGuard = new RemoteTerminalGuard({ log: this.log, excludedNamePrefixes: [t('Run on tOS: {0}', '')] });
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

    watchSharedState() {
        if (this.sharedStateWatcher) {
            return;
        }
        try {
            const watchedNames = [path.basename(this.sessionFile), path.basename(this.ownerFile)];
            const watcher = fs.watch(path.dirname(this.sessionFile), (_event, filename) => {
                if (this.disposed) {
                    return;
                }
                const changed = filename && filename.toString();
                if (!changed || watchedNames.some((name) => changed === name || changed.startsWith(`${name}.`))) {
                    this.refreshStatus().catch((error) => this.log.debug(`Shared session refresh error: ${error.message}`));
                }
            });
            watcher.on('error', (error) => {
                this.log.warn(`Shared session watcher failed; status polling remains enabled: ${error.message}`);
                watcher.close();
                if (this.sharedStateWatcher === watcher) {
                    this.sharedStateWatcher = undefined;
                }
            });
            this.sharedStateWatcher = watcher;
        } catch (error) {
            this.log.warn(`Shared session watcher unavailable; status polling remains enabled: ${error.message}`);
        }
    }

    onWorkspaceChanged() {
        if (this.closeRequested && !this.isOwnerWindow()) {
            this.completeCloseRequest().catch((error) => this.log.error(`Could not finish closing the remote workspace: ${error.message}`));
        }
        this.refreshStatus().catch((error) => this.log.debug(`Status refresh error: ${error.message}`));
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

    stopHeartbeat() {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        const owner = readJson(this.ownerFile);
        if (owner && owner.pid === process.pid) {
            removeFile(this.ownerFile);
        }
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
        if (status.session && status.session.state === 'closing') {
            return 'closing';
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
        const refreshId = ++this.statusRefreshId;
        const session = this.readSession();
        this.cachedSession = session;
        let daemon = false;
        let mounted = false;
        let pendingUploads = 0;
        if (session || this.rclone.readState()) {
            daemon = await this.rclone.isDaemonAlive();
            if (session) {
                if (session.localWorkspace) {
                    mounted = fs.existsSync(session.localWorkspace);
                    pendingUploads = this.syncer ? this.syncer.pendingCount : 0;
                } else if (daemon && session.drive) {
                    mounted = await this.rclone.isMounted(session.drive);
                    if (mounted) {
                        pendingUploads = await this.rclone.pendingUploads();
                    }
                }
            }
        }
        if (refreshId !== this.statusRefreshId) {
            return this.status;
        }
        const status = { session, daemon, mounted, pendingUploads, libSyncRunning: this.libSyncRunning };
        status.phase = this.computePhase(status);
        this.status = status;
        vscode.commands.executeCommand('setContext', 'tosRemote.workspaceOpen', this.isOwnerWindow());
        vscode.commands.executeCommand('setContext', 'tosRemote.mounted', mounted);
        this.emitter.fire(status);
        return status;
    }

    showBusy() {
        vscode.window.showInformationMessage(t('Another operation is in progress ({0}).', busyLabel(this.busy)));
    }

    // ---------------------------------------------------------------- 초기화

    async initialize() {
        this.watchSharedState();
        if (!this.workspaceChangeListener) {
            this.workspaceChangeListener = vscode.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceChanged());
        }
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

    // 원격 작업 공간을 닫으면 창이 빈 창으로 다시 로드되며, 이때 정리를 마무리한다
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
        // 이전 터미널 기록으로 복원된 로컬 터미널을 세션이 준비되는 대로 원격 터미널로 바꾼다
        this.terminalGuard.begin();
        let session = this.readSession();
        if (session && session.state === 'closing') {
            session = { ...session, state: 'open' };
            this.writeSession(session);
        }

        const ready = !!session && (await this.rclone.isDaemonAlive())
            && (session.localWorkspace ? fs.existsSync(session.localWorkspace) : (await this.rclone.isMounted(session.drive)));
        if (!ready) {
            this.setBusy('reconnecting');
            try {
                session = await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('Reconnecting to the remote workspace')
                }, (progress) => this.connect(getSettings(), session, progress, { interactive: true }));
            } catch (error) {
                this.setBusy(undefined);
                this.terminalGuard.stop();
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

            const last = this.context.globalState.get('tosRemote.lastAutoReload') || 0;
            if (Date.now() - last > AUTO_RELOAD_GUARD_MS) {
                await this.context.globalState.update('tosRemote.lastAutoReload', Date.now());
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return undefined;
            }
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        }

        if (session && session.localWorkspace) {
            this.syncer.startWatch(session);
        }

        // 확장 업데이트·표시 언어 변경을 반영하도록 작업 공간 파일을 갱신(내용이 같으면 쓰지 않음)
        this.writeWorkspaceFile(session);
        this.terminalGuard.activate(this.terminalLaunch());
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
            const current = this.readSession();
            if (current && ((current.localWorkspace && fs.existsSync(current.localWorkspace)) || await this.rclone.isMounted(current.drive))) {
                vscode.window.showInformationMessage(t('The remote workspace is already open.'));
            } else {
                await this.recover(current, true);
            }
            return;
        }
        const previous = this.readSession();
        if (previous && this.otherOwnerAlive()) {
            const goTo = t('Go to That Window');
            const pick = await vscode.window.showInformationMessage(t('The remote workspace is open in another window.'), goTo);
            if (pick === goTo) {
                await this.focusWorkspaceWindow();
            }
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

        const windowChoice = await vscode.window.showQuickPick([
            { label: t('Current Window'), description: t('Replace the current workspace with the remote workspace.'), forceNewWindow: false },
            { label: t('New Window'), description: t('Keep the current workspace open.'), forceNewWindow: true }
        ], { placeHolder: t('Where should the remote workspace open?') });
        if (!windowChoice) {
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
        await this.openWorkspaceWindow(windowChoice.forceNewWindow);
    }

    openWorkspaceWindow(forceNewWindow = false) {
        return vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(this.workspaceFile), { forceNewWindow });
    }

    focusWorkspaceWindow() {
        return vscode.commands.executeCommand('workbench.action.switchWindow');
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
     * 보드 접속 → rclone 데몬 → 소스 동기화 → 작업 공간 파일 생성까지 수행하고 세션을 기록한다.
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

        // 로컬 작업 사본 경로 결정
        let localWorkspace = options.localWorkspace || settings.localWorkspace || (sameIdentity && previous && previous.localWorkspace);
        if (!localWorkspace && options.interactive) {
            const defaultFolder = path.join(os.homedir(), 'tOS', settings.workspaceFolder || 'Workspace');
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                title: t('Select Local Workspace Folder'),
                defaultUri: vscode.Uri.file(defaultFolder),
                openLabel: t('Select Folder')
            });
            if (picked && picked[0]) {
                localWorkspace = picked[0].fsPath;
                // 사용자가 지정한 경로를 설정에 저장
                try {
                    await vscode.workspace.getConfiguration('tosRemote').update('localWorkspace', localWorkspace, vscode.ConfigurationTarget.Global);
                } catch {
                    // 무시
                }
            }
        }
        if (!localWorkspace) {
            localWorkspace = path.join(os.homedir(), 'tOS', settings.workspaceFolder || 'Workspace');
        }

        fs.mkdirSync(localWorkspace, { recursive: true });

        // 보드 -> 로컬 소스 초기 동기화
        report(t('Syncing source code from board'));
        try {
            await this.syncer.initialPull(localWorkspace, target, auth, settings.remoteWorkspace, (msg) => report(msg));
        } catch (syncErr) {
            this.log.warn(`Initial pull warning: ${syncErr.message}`);
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
            localWorkspace,
            drive: '',
            authType: auth.type,
            keyPath: auth.type === 'key' ? auth.keyPath : undefined,
            pythonCommand: settings.pythonCommand,
            debugPort: settings.debugPort,
            libraries,
            libraryAliases: aliases,
            boardTools: tools ? { probe: tools, checkedAt: Date.now() } : kept.boardTools,
            jupyter: kept.jupyter,
            openedAt: Date.now()
        };

        this.syncer.startWatch(session);
        this.writeWorkspaceFile(session);
        this.writeSession(session);
        return session;
    }

    /**
     * IntelliSense용 보드 Python 라이브러리 경로 결정.
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

    /** 작업 공간 터미널 프로필과 같은 SSH 터미널 실행 정보 */
    terminalLaunch() {
        const scriptPath = terminalScriptPath(this.storageDir, 'ssh-terminal');
        return { ...terminalShellLaunch(scriptPath), scriptPath };
    }

    writeWorkspaceFile(session) {
        const target = { host: session.host, port: session.port, user: session.user };
        const sshArgs = this.ssh.baseArgs(target, { keyPath: session.authType === 'key' ? session.keyPath : undefined });

        // SSH 터미널 스크립트가 연결 실패 재시도와 종료 코드 알림 방지를 담당한다
        const launch = this.terminalLaunch();
        const script = buildSshTerminalScript(this.ssh.sshPath, sshTerminalArgs(sshArgs, target, session.remoteWorkspace));
        writeIfChanged(launch.scriptPath, script);
        if (process.platform !== 'win32') {
            fs.chmodSync(launch.scriptPath, 0o700);
        }

        const content = JSON.stringify(buildWorkspace({
            localWorkspace: session.localWorkspace,
            drive: session.drive,
            target,
            remoteWorkspace: session.remoteWorkspace,
            sshPath: this.ssh.sshPath,
            sshArgs,
            platform: process.platform,
            terminal: {
                path: launch.shellPath,
                args: launch.shellArgs
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
                const daemonAlive = await this.rclone.isDaemonAlive();
                if (!daemonAlive) {
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
        this.log.warn('Connection lost. Reconnecting...');
        this.setBusy('reconnecting');
        try {
            const updated = await this.connect(getSettings(), session, { report() {} }, {
                interactive,
                quick: true,
                localWorkspace: session && session.localWorkspace
            });
            this.watchdogFailures = 0;
            this.log.info(`Reconnected (${updated.localWorkspace || updated.drive})`);
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
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
            this.closeTimer = setTimeout(() => {
                if (this.disposed || !this.closeRequested) {
                    return;
                }
                if (!this.isOwnerWindow()) {
                    this.completeCloseRequest().catch((error) => this.log.error(`Could not finish closing the remote workspace: ${error.message}`));
                } else {
                    this.cancelCloseRequest().catch((error) => this.log.error(`Could not restore the remote workspace state: ${error.message}`));
                }
            }, 15000);
            try {
                await vscode.commands.executeCommand('workbench.action.closeFolder');
                if (!this.isOwnerWindow()) {
                    await this.completeCloseRequest();
                }
            } catch (error) {
                await this.cancelCloseRequest();
                throw error;
            }
            return;
        }
        if (session && this.otherOwnerAlive()) {
            const goTo = t('Go to That Window');
            const pick = await vscode.window.showInformationMessage(t('The remote workspace is open in another window. Close it from that window.'), goTo);
            if (pick === goTo) {
                await this.focusWorkspaceWindow();
            }
            return;
        }
        if (!session && !(await this.rclone.isDaemonAlive())) {
            vscode.window.showInformationMessage(t('No remote workspace is open.'));
            return;
        }
        await this.finishClose();
    }

    async completeCloseRequest() {
        if (!this.closeRequested) {
            return;
        }
        this.closeRequested = false;
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        clearTimeout(this.watchdogTimer);
        clearTimeout(this.librarySyncTimer);
        this.terminalGuard.stop();
        this.stopHeartbeat();
        await this.finishClose();
    }

    async cancelCloseRequest() {
        if (!this.closeRequested) {
            return;
        }
        this.closeRequested = false;
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        const current = this.readSession();
        if (current && current.state === 'closing') {
            this.writeSession({ ...current, state: 'open' });
        }
        this.setBusy(undefined);
        await this.refreshStatus();
    }

    async finishClose() {
        this.setBusy('closing');
        const uploading = (count) => t('Uploading to the board... ({0} remaining)', count);
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Closing the remote workspace')
            }, async (progress) => {
                if (this.syncer) {
                    progress.report({ message: uploading(this.syncer.pendingCount) });
                    await this.syncer.flush(30000);
                    this.syncer.stopWatch();
                }
                if (await this.rclone.isDaemonAlive()) {
                    await this.rclone.quitDaemon();
                }
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

    /** 업로드 완료 대기 */
    async waitForUploads(timeoutMs) {
        if (this.syncer) {
            return this.syncer.flush(timeoutMs);
        }
        return true;
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

    /** 보드에서 로컬로 최신 파일 가져오기 (Pull) */
    async refreshDrive() {
        const session = this.readSession();
        if (!session || !session.localWorkspace) {
            vscode.window.showInformationMessage(t('No remote workspace is open.'));
            return;
        }
        const target = { host: session.host, port: session.port, user: session.user };
        const auth = await this.resolveSessionAuth(session);
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Pulling changes from the board')
        }, async (progress) => {
            await this.syncer.initialPull(session.localWorkspace, target, auth, session.remoteWorkspace, (msg) => progress.report({ message: msg }));
        });
        await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
        vscode.window.setStatusBarMessage(t('tOS: Synced from board.'), 3000);
    }

    /** 터미널 링크·디버그 경로 매핑용 (원격 경로 → 로컬 경로) */
    getPathMappings() {
        const session = this.cachedSession;
        if (!session) {
            return [];
        }
        const localRoot = session.localWorkspace ? path.normalize(session.localWorkspace) : `${session.drive}\\`;
        return [
            { remote: session.remoteWorkspace, local: localRoot },
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
        clearTimeout(this.watchdogTimer);
        clearTimeout(this.librarySyncTimer);
        clearTimeout(this.closeTimer);
        if (this.sharedStateWatcher) {
            this.sharedStateWatcher.close();
            this.sharedStateWatcher = undefined;
        }
        if (this.workspaceChangeListener) {
            this.workspaceChangeListener.dispose();
            this.workspaceChangeListener = undefined;
        }
        this.terminalGuard.dispose();
        if (this.syncer) {
            this.syncer.dispose();
        }
        this.stopHeartbeat();
        this.emitter.dispose();
    }
}

module.exports = { SessionManager };
