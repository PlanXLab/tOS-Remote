'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { SshClient } = require('./ssh');
const { Rclone } = require('./rclone');
const { AuthManager } = require('./auth');
const { Prerequisites } = require('./prereq');
const { SessionManager } = require('./session');
const { Runner, DebugConfigurationProvider } = require('./runner');
const { TerminalLinkProvider } = require('./terminalLinks');
const { StatusBar } = require('./statusBar');
const { PanelProvider } = require('./panel');
const { getSettings, validateSettings, targetOf, SECTION } = require('./settings');
const { probeTcp } = require('./util');
const { t } = require('./i18n');

const EXTENSION_ID = 'PlanXLab.tos-remote';
const WALKTHROUGH_ID = `${EXTENSION_ID}#tosRemote.gettingStarted`;

let sessionManager;
let runnerInstance;

function activate(context) {
    const log = vscode.window.createOutputChannel('tOS Remote', { log: true });
    context.subscriptions.push(log);

    const storageDir = context.globalStorageUri.fsPath;
    fs.mkdirSync(storageDir, { recursive: true });
    const localDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'tOS Remote');

    const ssh = new SshClient({ knownHostsFile: path.join(storageDir, 'known_hosts'), logger: log });
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
    sessionManager = sessionMgr;
    runnerInstance = runner;
    sessionMgr.onBeforeClose = async () => {
        if (vscode.debug.activeDebugSession) {
            await vscode.debug.stopDebugging();
        }
        runner.stopDebuggee(false);
    };

    const statusBar = new StatusBar();
    const panel = new PanelProvider(context, { sessionMgr, prereq, auth });

    context.subscriptions.push(
        statusBar,
        prereq,
        { dispose: () => runner.dispose() },
        { dispose: () => sessionMgr.dispose() },
        sessionMgr.onDidChange((status) => {
            statusBar.update(status);
            panel.postState();
        }),
        prereq.onDidChange(() => panel.postState()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(SECTION)) {
                panel.postState();
            }
        }),
        vscode.window.registerWebviewViewProvider('tosRemote.panel', panel),
        vscode.window.registerTerminalLinkProvider(new TerminalLinkProvider(sessionMgr)),
        vscode.debug.registerDebugConfigurationProvider('tos-remote', new DebugConfigurationProvider(runner, sessionMgr)),
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (session.configuration && session.configuration.tosRemote) {
                runner.stopDebuggee(false);
            }
        })
    );

    const commands = {
        'tosRemote.openWorkspace': () => sessionMgr.open(),
        'tosRemote.closeWorkspace': () => sessionMgr.close(),
        'tosRemote.focusWorkspaceWindow': () => sessionMgr.openWorkspaceWindow(),
        'tosRemote.testConnection': () => testConnection({ ssh, auth, prereq, panel, log }),
        'tosRemote.setupSshKey': () => setupSshKey({ auth, prereq, sessionMgr, panel, log }),
        'tosRemote.setPassword': () => setPassword({ auth, panel }),
        'tosRemote.clearPassword': () => clearPassword({ auth, panel }),
        'tosRemote.syncPythonLibraries': () => sessionMgr.syncLibraries(undefined, true),
        'tosRemote.refreshDrive': () => sessionMgr.refreshDrive().catch((error) => sessionMgr.reportError(t('Could not refresh the drive.'), error)),
        'tosRemote.showLog': () => log.show(),
        'tosRemote.showRcloneLog': () => showRcloneLog(rclone),
        'tosRemote.openSettings': () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`),
        'tosRemote.openWalkthrough': () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false),
        'tosRemote.installRclone': () => prereq.installRclone(),
        'tosRemote.installWinFsp': () => prereq.installWinFsp(),
        'tosRemote.runFile': (uri) => runner.runFile(uri),
        'tosRemote.debugFile': (uri) => runner.debugFile(uri),
        'tosRemote.showMenu': () => showMenu(sessionMgr)
    };
    for (const [id, handler] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }

    if (process.platform !== 'win32') {
        log.warn('tOS Remote currently supports Windows only.');
    }
    const settings = getSettings();
    vscode.commands.executeCommand('setContext', 'tosRemote.sshKeyReady', !!settings.host && auth.wasKeyOk(targetOf(settings)));
    prereq.refresh().catch((error) => log.warn(`Prerequisite check error: ${error.message}`));
    sessionMgr.initialize().catch((error) => log.error(`Initialization error: ${error.stack || error.message}`));

    // 통합 테스트용 내부 API
    return { sessionMgr, rclone, auth, prereq, ssh, runner };
}

async function testConnection({ ssh, auth, prereq, panel, log }) {
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
                await vscode.commands.executeCommand('setContext', 'tosRemote.sshKeyReady', true);
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
        await vscode.commands.executeCommand('setContext', 'tosRemote.connectionTested', true);
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

async function setupSshKey({ auth, prereq, sessionMgr, panel, log }) {
    const settings = getSettings();
    const invalid = validateSettings(settings);
    if (invalid) {
        vscode.window.showErrorMessage(invalid);
        return;
    }
    if (!prereq.ssh.sshPath || !prereq.ssh.keygenPath) {
        vscode.window.showErrorMessage(t('The OpenSSH client (ssh.exe, ssh-keygen.exe) is required.'));
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
        await vscode.commands.executeCommand('setContext', 'tosRemote.sshKeyReady', true);
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

async function showMenu(sessionMgr) {
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
        items.push({ label: `$(refresh) ${t('Refresh Drive')}`, command: 'tosRemote.refreshDrive' });
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
    if (sessionManager) {
        sessionManager.dispose();
    }
}

module.exports = { activate, deactivate };
