'use strict';

const crypto = require('crypto');
const vscode = require('vscode');
const { getSettings, updateSetting, targetOf } = require('./settings');
const { findExistingKey } = require('./ssh');
const { t } = require('./i18n');

const ALLOWED_COMMANDS = new Set([
    'tosRemote.openWorkspace',
    'tosRemote.closeWorkspace',
    'tosRemote.focusWorkspaceWindow',
    'tosRemote.testConnection',
    'tosRemote.setupSshKey',
    'tosRemote.setPassword',
    'tosRemote.clearPassword',
    'tosRemote.selectLocalWorkspace',
    'tosRemote.syncPythonLibraries',
    'tosRemote.refreshDrive',
    'tosRemote.showLog',
    'tosRemote.showRcloneLog',
    'tosRemote.openSettings',
    'tosRemote.openWalkthrough',
    'tosRemote.installRclone',
    'tosRemote.installUv',
    'tosRemote.checkBoardTools',
    'tosRemote.installDebugTools',
    'tosRemote.installJupyter',
    'tosRemote.startJupyter',
    'tosRemote.stopJupyter',
    'tosRemote.showJupyterLog'
]);

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 웹뷰(media/panel.js)에서 사용할 번역 문자열
function webviewStrings() {
    return {
        phaseIdle: t('Remote workspace closed'),
        phaseOpening: t('Opening...'),
        phaseReconnecting: t('Reconnecting...'),
        phaseClosing: t('Closing...'),
        phaseOpen: t('Remote workspace open'),
        phaseElsewhere: t('Open in another window'),
        phaseDetached: t('Remote workspace detached'),
        authKey: t('Auth: SSH key'),
        authPassword: t('Auth: password'),
        pendingUploads: t('Pending uploads to the board: {0}'),
        libSyncRunning: t('Syncing Python libraries...'),
        openWorkspace: t('▶ Open Remote Workspace'),
        reopenWorkspace: t('▶ Reopen Remote Workspace'),
        closeWorkspace: t('■ Close Remote Workspace'),
        unmount: t('■ Close Workspace'),
        settingsLocked: t('Close the remote workspace to change board settings.'),
        keyOk: t('Using SSH key authentication'),
        keyUnverified: t('SSH key found (not verified on the board)'),
        keyNone: t('No SSH key'),
        checkAgain: t('Check Again'),
        registerKey: t('Register SSH Key'),
        passwordSaved: t('Password saved'),
        passwordNotSaved: t('Password not saved'),
        change: t('Change'),
        save: t('Save'),
        customRclone: t('(custom)'),
        readyChecking: t('✓ Ready (checking...)'),
        checking: t('Checking...'),
        ready: t('✓ Ready'),
        needsAttention: t('⚠ Needs attention'),
        uvInstalled: t('uv v{0} (board package resolution)'),
        uvNotInstalled: t('uv (downloaded when installing board packages)'),
        toolsUnavailable: t('Open the remote workspace in this window to check the board tools.'),
        toolsNotChecked: t('Not checked yet'),
        toolsError: t('Check failed: {0}'),
        toolsInstalling: t('Installing...'),
        pythonInfo: t('Python {0} · {1} · {2}'),
        debugReady: t('Debugging: debugpy {0}'),
        debugMissing: t('Debugging: debugpy not installed'),
        debugNoScript: t('Debugging: debugpy {0} (run_debug.sh missing)'),
        jupyterReady: t('Jupyter: jupyter_server {0}, ipykernel {1}'),
        jupyterMissing: t('Jupyter: not installed'),
        jupyterStopped: t('Jupyter server stopped'),
        jupyterStarting: t('Starting the Jupyter server...'),
        jupyterRunning: t('Jupyter server running (PC port {0})'),
        jupyterReconnecting: t('Reconnecting to the Jupyter server...'),
        jupyterStopping: t('Stopping the Jupyter server...'),
        jupyterHint: t('To run cells on the board, choose "tOS Remote" in Select Kernel.'),
        jupyterExtensionMissing: t('Install the Jupyter extension (ms-toolsai.jupyter) to run cells.')
    };
}

class PanelProvider {
    constructor(context, services) {
        this.context = context;
        this.services = services;
        this.view = undefined;
        this.lastTest = undefined;
    }

    setLastTest(result) {
        this.lastTest = { ...result, time: Date.now() };
        this.postState();
    }

    resolveWebviewView(view) {
        this.view = view;
        const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
        view.webview.html = this.getHtml(view.webview, mediaRoot);
        view.webview.onDidReceiveMessage((message) => this.onMessage(message));
        view.onDidChangeVisibility(() => {
            if (view.visible) {
                this.services.prereq.refresh().catch(() => {});
                this.checkBoardToolsOnce();
                this.postState();
            }
        });
        view.onDidDispose(() => {
            this.view = undefined;
        });
    }

    // 패널이 보일 때 아직 보드 도구를 확인하지 않았으면 한 번 확인한다 (원격 작업 공간 창에서만)
    checkBoardToolsOnce() {
        const tools = this.services.boardTools;
        const status = tools.status();
        if (status.available && !status.checked && !status.checking && !status.error) {
            tools.check().catch(() => {});
        }
    }

    async onMessage(message) {
        if (!message || typeof message !== 'object') {
            return;
        }
        if (message.type === 'ready') {
            this.checkBoardToolsOnce();
            await this.postState();
        } else if (message.type === 'setting') {
            try {
                await updateSetting(message.key, message.value);
            } catch (error) {
                this.view && this.view.webview.postMessage({ type: 'settingError', key: message.key, message: error.message });
            }
            await this.postState();
        } else if (message.type === 'command' && ALLOWED_COMMANDS.has(message.id)) {
            vscode.commands.executeCommand(message.id);
        }
    }

    async postState() {
        if (!this.view) {
            return;
        }
        const { sessionMgr, prereq, auth, boardTools, jupyter } = this.services;
        const settings = getSettings();
        const target = targetOf(settings);
        const status = sessionMgr.status || {};
        const session = status.session;
        const state = {
            settings: {
                host: settings.host,
                port: settings.port,
                user: settings.user,
                remoteWorkspace: settings.workspaceFolder,
                localWorkspace: settings.localWorkspace || '',
                driveLetter: settings.driveLetter
            },
            phase: status.phase || 'idle',
            session: session ? {
                drive: session.drive,
                localWorkspace: session.localWorkspace,
                host: session.host,
                port: session.port,
                user: session.user,
                remoteWorkspace: session.remoteWorkspace,
                authType: session.authType
            } : undefined,
            mounted: !!status.mounted,
            pendingUploads: status.pendingUploads || 0,
            libSyncRunning: !!sessionMgr.libSyncRunning,
            prereq: {
                checked: !!prereq.checked,
                ssh: !!prereq.state.ssh,
                rcloneVersion: prereq.state.rcloneVersion,
                customRclone: !!settings.rclonePath,
                uvVersion: prereq.state.uvVersion
            },
            tools: boardTools.status(),
            jupyter: jupyter.status(),
            auth: {
                keyFile: settings.host ? findExistingKey(settings.identityFile) : undefined,
                keyOk: settings.host ? auth.wasKeyOk(target) : false,
                passwordSaved: settings.host && settings.user ? await auth.hasPassword(target) : false
            },
            lastTest: this.lastTest
        };
        this.view.webview.postMessage({ type: 'state', state });
    }

    getHtml(webview, mediaRoot) {
        const nonce = crypto.randomBytes(16).toString('base64');
        const css = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.css'));
        const js = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'panel.js'));
        const h = escapeHtml;
        const strings = JSON.stringify(webviewStrings()).replace(/</g, '\\u003c');
        const lang = vscode.env.language && vscode.env.language.startsWith('ko') ? 'ko' : 'en';
        return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${css}" rel="stylesheet">
<title>tOS Remote</title>
</head>
<body>
<section class="status-card" id="statusCard">
    <div class="status-line"><span class="dot" id="statusDot"></span><span id="statusText">${h(t('Checking status...'))}</span></div>
    <div class="status-detail" id="statusAccount"></div>
    <div class="status-detail" id="statusWorkspace"></div>
    <div class="status-detail" id="statusAuth"></div>
    <div class="status-detail status-extra" id="statusExtra"></div>
</section>

<div class="actions" id="mainActions">
    <button class="primary big" id="btnOpen" data-command="tosRemote.openWorkspace">${h(t('▶ Open Remote Workspace'))}</button>
    <button class="primary big" id="btnFocus" data-command="tosRemote.focusWorkspaceWindow">${h(t('Go to Remote Workspace Window'))}</button>
    <button class="danger big" id="btnClose" data-command="tosRemote.closeWorkspace">${h(t('■ Close Remote Workspace'))}</button>
</div>

<details open>
    <summary>${h(t('Board'))}</summary>
    <div class="form">
        <label for="host">${h(t('Host'))}</label>
        <input id="host" data-setting="host" type="text" spellcheck="false" placeholder="192.168.254.1">
        <label for="port">${h(t('Port'))}</label>
        <input id="port" data-setting="port" type="number" min="1" max="65535">
        <label for="user">${h(t('User'))}</label>
        <input id="user" data-setting="user" type="text" spellcheck="false" placeholder="tos">
        <label for="remoteWorkspace">${h(t('Workspace'))}</label>
        <div class="prefixed" title="${h(t('Folder under your home directory. Created on the board if it does not exist.'))}">
            <span class="prefix" id="workspacePrefix">/home/tos/</span>
            <input id="remoteWorkspace" data-setting="remoteWorkspace" type="text" spellcheck="false" placeholder="Workspace">
        </div>
        <label for="localWorkspace">${h(t('Local Folder'))}</label>
        <div style="display:flex;gap:4px;">
            <input id="localWorkspace" data-setting="localWorkspace" type="text" spellcheck="false" placeholder="C:\\Workspace\\my-project">
            <button class="secondary" id="btnSelectLocal" data-command="tosRemote.selectLocalWorkspace" style="white-space:nowrap;">${h(t('Browse'))}</button>
        </div>
    </div>
    <div class="hint" id="formHint"></div>
    <div class="row">
        <button class="secondary" id="btnTest" data-command="tosRemote.testConnection">${h(t('Test Connection'))}</button>
        <span class="test-result" id="testResult"></span>
    </div>
</details>

<details open>
    <summary>${h(t('Authentication'))}</summary>
    <div class="check-list">
        <div class="check"><span class="mark" id="keyMark"></span><span id="keyText">${h(t('SSH key'))}</span>
            <button class="link" id="btnKey" data-command="tosRemote.setupSshKey">${h(t('Register SSH Key'))}</button></div>
        <div class="check"><span class="mark" id="pwMark"></span><span id="pwText">${h(t('Password'))}</span>
            <button class="link" id="btnPwSet" data-command="tosRemote.setPassword">${h(t('Save'))}</button>
            <button class="link" id="btnPwClear" data-command="tosRemote.clearPassword">${h(t('Delete'))}</button></div>
    </div>
</details>

<details id="prereqSection">
    <summary>${h(t('Prerequisites'))} <span class="summary-badge" id="prereqBadge"></span></summary>
    <div class="check-list">
        <div class="check"><span class="mark" id="rcloneMark"></span><span id="rcloneText">rclone</span>
            <button class="link" id="btnRclone" data-command="tosRemote.installRclone">${h(t('Download'))}</button></div>
        <div class="check"><span class="mark" id="sshMark"></span><span>${h(t('OpenSSH Client'))}</span></div>
        <div class="check"><span class="mark" id="uvMark"></span><span id="uvText">uv</span>
            <button class="link" id="btnUv" data-command="tosRemote.installUv">${h(t('Download'))}</button></div>
    </div>
</details>

<details open id="toolsSection">
    <summary>${h(t('Board Tools'))} <span class="summary-badge" id="toolsBadge"></span></summary>
    <div class="hint" id="toolsHint"></div>
    <div class="check-list" id="toolsList">
        <div class="check"><span class="mark" id="pythonMark"></span><span id="pythonText">Python</span></div>
        <div class="check"><span class="mark" id="debugMark"></span><span id="debugText"></span>
            <button class="link" id="btnInstallDebug" data-command="tosRemote.installDebugTools">${h(t('Install'))}</button></div>
        <div class="check"><span class="mark" id="jupyterMark"></span><span id="jupyterText"></span>
            <button class="link" id="btnInstallJupyter" data-command="tosRemote.installJupyter">${h(t('Install'))}</button></div>
        <div class="check" id="jupyterServerRow"><span class="dot" id="jupyterDot"></span><span id="jupyterServerText"></span>
            <span class="inline-actions">
                <button class="link" id="btnJupyterStart" data-command="tosRemote.startJupyter">${h(t('Start'))}</button>
                <button class="link" id="btnJupyterStop" data-command="tosRemote.stopJupyter">${h(t('Stop'))}</button>
            </span></div>
    </div>
    <div class="hint" id="jupyterHint"></div>
    <div class="row">
        <button class="link" id="btnToolsCheck" data-command="tosRemote.checkBoardTools">${h(t('Check Again'))}</button>
        <button class="link" id="btnJupyterLog" data-command="tosRemote.showJupyterLog">${h(t('Jupyter Log'))}</button>
    </div>
</details>

<details open>
    <summary>${h(t('Tools'))}</summary>
    <div class="tools">
        <button class="link" id="btnSync" data-command="tosRemote.syncPythonLibraries">${h(t('Sync Python Libraries'))}</button>
        <button class="link" id="btnRefresh" data-command="tosRemote.refreshDrive">${h(t('Pull from Board'))}</button>
        <button class="link" data-command="tosRemote.showLog">${h(t('Show Log'))}</button>
        <button class="link" data-command="tosRemote.showRcloneLog">${h(t('rclone Log'))}</button>
        <button class="link" data-command="tosRemote.openSettings">${h(t('All Settings'))}</button>
        <button class="link" data-command="tosRemote.openWalkthrough">${h(t('Getting Started'))}</button>
    </div>
</details>
<script id="l10n" type="application/json">${strings}</script>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    }
}

module.exports = { PanelProvider, webviewStrings };
