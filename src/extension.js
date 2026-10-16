'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { SshClient } = require('./ssh');
const { AskpassBroker } = require('./askpass');
const { Rclone } = require('./rclone');
const { AuthManager } = require('./auth');
const { Prerequisites } = require('./prereq');
const { SessionManager } = require('./session');
const { Runner, DebugConfigurationProvider } = require('./runner');
const { BoardTools } = require('./boardTools');
const { JupyterManager } = require('./jupyter');
const { TerminalLinkProvider } = require('./terminalLinks');
const { StatusBar } = require('./statusBar');
const { PanelProvider } = require('./panel');
const { WalkthroughState } = require('./walkthrough');
const { getSettings, validateSettings, targetOf, migrateSettings, SECTION } = require('./settings');
const { probeTcp, userCacheDirectory } = require('./util');
const { t } = require('./i18n');

const EXTENSION_ID = 'PlanXLab.tos-remote';
const WALKTHROUGH_ID = `${EXTENSION_ID}#tosRemote.gettingStarted`;
// "#%%" 셀이 있는 Python 파일 (Jupyter 커널 선택기에 tOS 서버를 미리 등록)
const CELL_MARKER = /^\s*#\s*%%/m;

let sessionManager;
let runnerInstance;
let jupyterManager;

function activate(context) {
    const log = vscode.window.createOutputChannel('tOS Remote', { log: true });
    context.subscriptions.push(log);

    const storageDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(storageDir, { recursive: true });
    const localDir = userCacheDirectory('tOS Remote');

    // 비밀번호 인증용 SSH_ASKPASS 도우미 (VS Code의 Node.js로 실행)
    const askpass = new AskpassBroker({
        storageDir,
        nodeExecutable: process.execPath,
        helperScript: path.join(context.extensionPath, 'src', 'askpassHelper.js'),
        logger: log
    });
    const ssh = new SshClient({ knownHostsFile: path.join(storageDir, 'known_hosts'), logger: log, askpass });
    const prereq = new Prerequisites(context, ssh, log, path.join(storageDir, 'bin'));
    const rclone = new Rclone({
        storageDir,
        cacheDir: path.join(localDir, 'rclone-cache'),
        getExePath: () => prereq.rcloneExePath(),
        logger: log
    });
    prereq.rclone = rclone;
    const auth = new AuthManager(context, ssh, rclone, log);
    const sessionMgr = new SessionManager({ context, log, ssh, rclone, auth, prereq, storageDir });
    const runner = new Runner(sessionMgr, ssh, log);
    const boardTools = new BoardTools({ log, ssh, rclone, sessionMgr, prereq, auth, storageDir, localDir });
    const jupyter = new JupyterManager({ log, ssh, sessionMgr, boardTools });
    runner.boardTools = boardTools;
    sessionManager = sessionMgr;
    runnerInstance = runner;
    jupyterManager = jupyter;
    sessionMgr.onBeforeClose = async () => {
        if (vscode.debug.activeDebugSession) {
            await vscode.debug.stopDebugging();
        }
        runner.stopDebuggee(false);
        // 작업 공간을 닫으면 이 창에서 시작한 보드 Jupyter 서버도 끝낸다
        await jupyter.stop({ quiet: true });
    };

    const statusBar = new StatusBar();
    const panel = new PanelProvider(context, { sessionMgr, prereq, auth, boardTools, jupyter });
    const walkthrough = new WalkthroughState({
        globalState: context.globalState,
        setContext: (key, value) => vscode.commands.executeCommand('setContext', key, value)
    });
    // 시작 가이드 단계를 현재 상태에 맞춘다 (작업 공간이 열려 있으면 연결·열기 단계도 완료)
    const syncWalkthrough = async (session) => {
        try {
            if (session) {
                await walkthrough.markOpened();
                await walkthrough.markConnected(targetOf(session));
            }
            const settings = getSettings();
            const target = settings.host ? targetOf(settings) : undefined;
            walkthrough.update({ target, keyOk: !!target && auth.wasKeyOk(target) });
        } catch (error) {
            log.debug(`Walkthrough state update failed: ${error.message}`);
        }
    };
    const markConnected = async (target) => {
        await walkthrough.markConnected(target);
        await syncWalkthrough();
    };

    context.subscriptions.push(
        statusBar,
        prereq,
        { dispose: () => runner.dispose() },
        { dispose: () => jupyter.dispose() },
        { dispose: () => sessionMgr.dispose() },
        sessionMgr.onDidChange((status) => {
            statusBar.update(status);
            panel.postState();
            syncWalkthrough(status && status.session);
        }),
        prereq.onDidChange(() => panel.postState()),
        boardTools.onDidChange(() => panel.postState()),
        jupyter.onDidChange((status) => {
            statusBar.setJupyter(status.phase);
            panel.postState();
        }),
        vscode.extensions.onDidChange(() => panel.postState()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(SECTION)) {
                panel.postState();
                syncWalkthrough();
            }
        }),
        // Interactive 창·노트북을 열거나 #%% 셀이 있는 파일을 볼 때 커널 선택기에 tOS 서버를 등록한다
        vscode.workspace.onDidOpenNotebookDocument(() => jupyter.registerCollection()),
        vscode.window.onDidChangeActiveNotebookEditor((editor) => jupyter.onActiveNotebookEditor(editor)),
        vscode.window.onDidChangeActiveTextEditor((editor) => registerForCells(jupyter, editor)),
        vscode.window.registerWebviewViewProvider('tosRemote.panel', panel),
        vscode.window.registerTerminalLinkProvider(new TerminalLinkProvider(sessionMgr)),
        vscode.debug.registerDebugConfigurationProvider('tos-remote', new DebugConfigurationProvider(runner, sessionMgr)),
        vscode.tasks.registerTaskProvider('tos-remote', runner),
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (session.configuration && session.configuration.tosRemote) {
                runner.detachDebuggee();
            }
        })
    );

    const commands = {
        'tosRemote.openWorkspace': () => sessionMgr.open(),
        'tosRemote.closeWorkspace': () => sessionMgr.close(),
        'tosRemote.focusWorkspaceWindow': () => sessionMgr.focusWorkspaceWindow(),
        'tosRemote.testConnection': () => testConnection({ ssh, auth, prereq, panel, log, markConnected }),
        'tosRemote.setupSshKey': () => setupSshKey({ auth, prereq, sessionMgr, panel, log, markConnected }),
        'tosRemote.setPassword': () => setPassword({ auth, panel }),
        'tosRemote.clearPassword': () => clearPassword({ auth, panel }),
        'tosRemote.selectLocalWorkspace': async () => {
            const current = getSettings().localWorkspace;
            const defaultUri = current ? vscode.Uri.file(current) : vscode.Uri.file(os.homedir());
            const picked = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectFiles: false,
                canSelectMany: false,
                title: t('Select Local Workspace Folder'),
                defaultUri,
                openLabel: t('Select Folder')
            });
            if (picked && picked[0]) {
                await vscode.workspace.getConfiguration(SECTION).update('localWorkspace', picked[0].fsPath, vscode.ConfigurationTarget.Global);
                panel.postState();
            }
        },
        'tosRemote.syncPythonLibraries': () => sessionMgr.syncLibraries(undefined, true),
        'tosRemote.refreshDrive': () => sessionMgr.refreshDrive().catch((error) => sessionMgr.reportError(t('Could not refresh the workspace.'), error)),
        'tosRemote.showLog': () => log.show(),
        'tosRemote.showRcloneLog': () => showRcloneLog(rclone),
        'tosRemote.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`),
        'tosRemote.openWalkthrough': () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false),
        'tosRemote.installRclone': () => prereq.installRclone(),
        'tosRemote.installUv': () => prereq.installUv(),
        'tosRemote.runFile': (uri) => runner.runFile(uri),
        'tosRemote.debugFile': (uri) => runner.debugFile(uri),
        'tosRemote.checkBoardTools': () => boardTools.check({ interactive: true })
            .catch((error) => sessionMgr.reportError(t('Could not check the board tools.'), error)),
        'tosRemote.installDebugTools': () => boardTools.install('debug'),
        'tosRemote.installJupyter': () => boardTools.install('jupyter'),
        'tosRemote.startJupyter': () => jupyter.start(),
        'tosRemote.stopJupyter': () => jupyter.stop(),
        'tosRemote.showJupyterLog': () => jupyter.showLog(),
        'tosRemote.showMenu': () => showMenu(sessionMgr, jupyter)
    };
    for (const [id, handler] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    syncWalkthrough(sessionMgr.readSession());
    prereq.refresh().catch((error) => log.warn(`Prerequisite check error: ${error.message}`));
    // 이전 형식(/home/<user>/Workspace)의 작업 공간 설정을 먼저 바꾼 뒤 세션을 초기화한다
    migrateSettings(log)
        .catch((error) => log.warn(`Settings migration error: ${error.message}`))
        .then(() => sessionMgr.initialize())
        .then(() => {
            if (sessionMgr.isOwnerWindow()) {
                // 이전에 시작한 보드 Jupyter 서버가 실행 중이면 다시 연결하고, 셀 실행 준비를 한다
                jupyter.attach().finally(() => {
                    const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
                    if (jupyterExtension && jupyterExtension.isActive) {
                        jupyter.registerCollection();
                    }
                    registerForCells(jupyter, vscode.window.activeTextEditor);
                    jupyter.onActiveNotebookEditor(vscode.window.activeNotebookEditor);
                });
            }
        })
        .catch((error) => log.error(`Initialization error: ${error.stack || error.message}`));

    // 통합 테스트용 내부 API
    return { sessionMgr, rclone, auth, prereq, ssh, runner, boardTools, jupyter, askpass };
}

function registerForCells(jupyter, editor) {
    const document = editor && editor.document;
    if (document && document.languageId === 'python' && document.lineCount < 20000 && CELL_MARKER.test(document.getText())) {
        jupyter.registerCollection();
        // Interactive 창을 열기 전에 보드 커널이 준비되도록 서버를 미리 시작한다
        jupyter.prepareForCells().catch((error) => jupyter.log.debug(`Jupyter auto-start failed: ${error.message}`));
    }
}

async function testConnection({ ssh, auth, prereq, panel, log, markConnected }) {
    const settings = getSettings();
    const invalid = validateSettings(settings);
    if (invalid) {
        panel.setLastTest({ ok: false, message: invalid });
        return;
    }
    const target = targetOf(settings);
    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('Testing connection to {0}', target.host)
    }, async (progress) => {
        progress.report({ message: t('Checking the SSH port') });
        const probe = await probeTcp(target.host, target.port, 5000);
        if (!probe.ok) {
            return { ok: false, message: t('Unreachable ({0})', probe.error) };
        }
        const server = probe.banner ? probe.banner.replace(/^SSH-2\.0-/, '') : 'SSH';
        if (ssh.sshPath) {
            progress.report({ message: t('Checking SSH key authentication') });
            ssh.resetKnownHosts();
            if (await auth.keyWorks(settings, target)) {
                return { ok: true, message: t('SSH key authentication succeeded ({0})', server) };
            }
        }
        const password = await auth.getPassword(target);
        if (password && prereq.state.rcloneVersion) {
            progress.report({ message: t('Checking password authentication') });
            const check = await auth.testPassword(target, password);
            return check.ok
                ? { ok: true, message: t('Password authentication succeeded ({0}). Registering an SSH key is recommended.', server) }
                : { ok: false, message: t('Password authentication failed: {0}', check.error) };
        }
        return { ok: false, message: t('The board responded ({0}). Register an SSH key or save a password.', server) };
    });
    log.info(`Connection test: ${result.ok ? 'OK' : 'FAILED'} - ${result.message}`);
    if (result.ok) {
        await markConnected(target);
    }
    panel.setLastTest(result);
    (result.ok ? vscode.window.showInformationMessage : vscode.window.showWarningMessage)(result.message);
}

async function ensureRclone(prereq) {
    const state = await prereq.refresh();
    if (state.rcloneVersion) {
        return true;
    }
    const download = t('Download');
    const pick = await vscode.window.showWarningMessage(t('This action requires rclone. Download it now? (about 30 MB)'), { modal: true }, download);
    if (pick !== download) {
        return false;
    }
    return !!(await prereq.installRclone());
}

async function setupSshKey({ auth, prereq, sessionMgr, panel, log, markConnected }) {
    const settings = getSettings();
    const invalid = validateSettings(settings);
    if (invalid) {
        vscode.window.showErrorMessage(invalid);
        return;
    }
    if (!prereq.ssh.sshPath || !prereq.ssh.keygenPath) {
        vscode.window.showErrorMessage(t('The OpenSSH client (ssh, ssh-keygen) is required.'));
        return;
    }
    const target = targetOf(settings);
    const probe = await probeTcp(target.host, target.port, 5000);
    if (!probe.ok) {
        vscode.window.showErrorMessage(t('Cannot connect to the board ({0}): {1}', `${target.host}:${target.port}`, probe.error));
        return;
    }
    if (!auth.wasKeyOk(target) && !(await ensureRclone(prereq))) {
        return;
    }
    try {
        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: t('Registering SSH key')
        }, (progress) => auth.setupKey(settings, target, (message) => progress.report({ message })));
        await markConnected(target);
        panel.setLastTest({ ok: true, message: t('SSH key authentication succeeded ({0})', path.basename(result.keyPath)) });
        const session = sessionMgr.readSession();
        const message = result.alreadyRegistered ? t('The SSH key is already registered.') : t('The SSH key was registered on the board.');
        if (session && session.authType === 'password') {
            vscode.window.showInformationMessage(`${message} ${t('Close and reopen the remote workspace to use key authentication.')}`);
        } else {
            vscode.window.showInformationMessage(message);
        }
    } catch (error) {
        log.error(`SSH key registration failed: ${error.message}`);
        vscode.window.showErrorMessage(`${t('SSH key registration failed.')}\n${error.message}`);
    }
    panel.postState();
}

async function setPassword({ auth, panel }) {
    const settings = getSettings();
    const invalid = validateSettings(settings);
    if (invalid) {
        vscode.window.showErrorMessage(invalid);
        return;
    }
    const saved = await auth.promptPassword(targetOf(settings));
    if (saved) {
        vscode.window.showInformationMessage(t('The password was saved to VS Code secret storage.'));
    }
    panel.postState();
}

async function clearPassword({ auth, panel }) {
    await auth.clearPassword(targetOf(getSettings()));
    vscode.window.showInformationMessage(t('The saved password was deleted.'));
    panel.postState();
}

async function showRcloneLog(rclone) {
    if (!fs.existsSync(rclone.logFile)) {
        vscode.window.showInformationMessage(t('There is no rclone log yet.'));
        return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(rclone.logFile));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    const end = document.lineAt(document.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end));
}

async function showMenu(sessionMgr, jupyter) {
    const phase = (sessionMgr.status && sessionMgr.status.phase) || 'idle';
    const items = [];
    if (phase === 'idle' || phase === 'detached') {
        items.push({ label: `$(remote) ${t('Open Remote Workspace')}`, command: 'tosRemote.openWorkspace' });
    }
    if (phase === 'elsewhere') {
        items.push({ label: `$(window) ${t('Go to Remote Workspace Window')}`, command: 'tosRemote.focusWorkspaceWindow' });
    }
    if (phase === 'open' || phase === 'detached' || phase === 'reconnecting') {
        items.push({ label: `$(close) ${t('Close Remote Workspace')}`, command: 'tosRemote.closeWorkspace' });
    }
    if (phase === 'open') {
        items.push({ label: `$(play) ${t('Run on tOS')}`, description: 'Ctrl+F5', command: 'tosRemote.runFile' });
        items.push({ label: `$(debug-alt) ${t('Debug on tOS')}`, description: 'F5', command: 'tosRemote.debugFile' });
        const jupyterRunning = jupyter.status().phase !== 'stopped';
        items.push(jupyterRunning
            ? { label: `$(debug-stop) ${t('Stop Jupyter on tOS')}`, command: 'tosRemote.stopJupyter' }
            : { label: `$(notebook) ${t('Start Jupyter on tOS')}`, command: 'tosRemote.startJupyter' });
        items.push({ label: `$(tools) ${t('Check Board Tools')}`, command: 'tosRemote.checkBoardTools' });
        items.push({ label: `$(refresh) ${t('Pull from Board')}`, command: 'tosRemote.refreshDrive' });
        items.push({ label: `$(library) ${t('Sync Python Libraries')}`, command: 'tosRemote.syncPythonLibraries' });
    }
    items.push(
        { label: `$(plug) ${t('Test Connection')}`, command: 'tosRemote.testConnection' },
        { label: `$(key) ${t('Register SSH Key')}`, command: 'tosRemote.setupSshKey' },
        { label: `$(output) ${t('Show Log')}`, command: 'tosRemote.showLog' },
        { label: `$(settings-gear) ${t('tOS Remote Panel')}`, command: 'tosRemote.panel.focus' }
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'tOS Remote', placeHolder: t('Select an action') });
    if (pick) {
        vscode.commands.executeCommand(pick.command);
    }
}

function deactivate() {
    if (runnerInstance) {
        runnerInstance.dispose();
    }
    if (jupyterManager) {
        jupyterManager.dispose();
    }
    if (sessionManager) {
        sessionManager.dispose();
    }
}

module.exports = { activate, deactivate };
