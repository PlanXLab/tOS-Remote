'use strict';

const path = require('path');
const vscode = require('vscode');
const { installRclone, findWinFsp, installUv, getUvVersion } = require('./installer');
const { Rclone, MIN_VERSION, compareVersions } = require('./rclone');
const { findExecutable } = require('./util');
const { getSettings } = require('./settings');
const { t } = require('./i18n');

const WINFSP_RELEASES = 'https://winfsp.dev/rel/';
const OPENSSH_DOCS = 'https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse';
const PREREQ_STATE_KEY = 'tosRemote.prereqState';
// pylock.toml 출력과 manylinux_2_40 대상을 지원하는 버전
const MIN_UV_VERSION = '0.8.0';

class Prerequisites {
    constructor(context, ssh, log, binDir) {
        this.context = context;
        this.ssh = ssh;
        this.log = log;
        this.binDir = binDir;
        this.rclone = undefined;
        // 새 창에서 점검이 끝나기 전에 "미설치"로 보이지 않도록 마지막 점검 결과로 시작한다
        this.state = context.globalState.get(PREREQ_STATE_KEY) || { winfsp: undefined, ssh: false, rcloneVersion: undefined };
        this.checked = false;
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
    }

    rcloneExePath() {
        return getSettings().rclonePath || path.join(this.binDir, 'rclone.exe');
    }

    uvExePath() {
        return path.join(this.binDir, 'uv.exe');
    }

    async refresh() {
        const [winfsp, rcloneVersion, uvVersion] = await Promise.all([findWinFsp(), this.rclone.getVersion(), getUvVersion(this.uvExePath())]);
        this.state = { winfsp, ssh: !!this.ssh.sshPath, rcloneVersion, uvVersion };
        this.checked = true;
        this.emitter.fire(this.state);
        await Promise.all([
            this.context.globalState.update(PREREQ_STATE_KEY, this.state),
            vscode.commands.executeCommand('setContext', 'tosRemote.winfspReady', !!winfsp),
            vscode.commands.executeCommand('setContext', 'tosRemote.rcloneReady', Rclone.isSupportedVersion(rcloneVersion)),
            vscode.commands.executeCommand('setContext', 'tosRemote.sshReady', this.state.ssh)
        ]);
        return this.state;
    }

    async ensureAll(options = {}) {
        if (process.platform !== 'win32') {
            throw new Error(t('tOS Remote currently supports Windows only.'));
        }
        let state = await this.refresh();
        if (!state.ssh) {
            if (options.interactive) {
                const howTo = t('How to Install');
                const pick = await vscode.window.showErrorMessage(t('The OpenSSH client (ssh.exe) is required. Add "OpenSSH Client" in Windows Settings > System > Optional features.'), howTo);
                if (pick === howTo) {
                    vscode.env.openExternal(vscode.Uri.parse(OPENSSH_DOCS));
                }
            }
            throw new Error(t('ssh.exe (OpenSSH client) was not found.'));
        }
        if (!state.winfsp) {
            if (options.interactive) {
                const install = t('Install WinFsp');
                const pick = await vscode.window.showWarningMessage(t('WinFsp, required for the virtual drive, is not installed. Install it now? (administrator approval required)'), { modal: true }, install);
                if (pick === install) {
                    await this.installWinFsp();
                    state = await this.refresh();
                }
            }
            if (!state.winfsp) {
                throw new Error(t('WinFsp is not installed.'));
            }
        }
        if (!Rclone.isSupportedVersion(state.rcloneVersion)) {
            const reason = state.rcloneVersion
                ? t('rclone {0} is not supported (minimum {1}).', state.rcloneVersion, MIN_VERSION)
                : t('rclone is not ready yet.');
            if (options.interactive && !getSettings().rclonePath) {
                const download = t('Download');
                const pick = await vscode.window.showWarningMessage(`${reason} ${t('Download the latest rclone? (about 30 MB)')}`, { modal: true }, download);
                if (pick === download) {
                    await this.installRclone();
                    state = await this.refresh();
                }
            }
            if (!Rclone.isSupportedVersion(state.rcloneVersion)) {
                throw new Error(getSettings().rclonePath ? `${reason} (tosRemote.rclonePath: ${getSettings().rclonePath})` : reason);
            }
        }
        return state;
    }

    async installRclone() {
        if (getSettings().rclonePath) {
            vscode.window.showInformationMessage(t('tosRemote.rclonePath ({0}) is set, so rclone will not be downloaded.', getSettings().rclonePath));
            return undefined;
        }
        // 한 번 설치한 rclone은 다시 내려받지 않는다 (업데이트 기능 없음)
        const installed = await this.rclone.getVersion();
        if (Rclone.isSupportedVersion(installed)) {
            vscode.window.showInformationMessage(t('rclone {0} is already installed.', installed));
            await this.refresh();
            return { version: installed, exePath: this.rcloneExePath() };
        }
        if (await this.rclone.isDaemonAlive()) {
            vscode.window.showWarningMessage(t('rclone is in use. Close the remote workspace and try again.'));
            return undefined;
        }
        try {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Installing rclone')
            }, (progress) => installRclone({
                binDir: this.binDir,
                logger: this.log,
                onProgress: (message) => progress.report({ message })
            }));
            vscode.window.showInformationMessage(t('rclone {0} installed.', result.version));
            await this.refresh();
            return result;
        } catch (error) {
            this.log.error(`rclone install failed: ${error.message}`);
            const openSettings = t('Open Settings');
            const pick = await vscode.window.showErrorMessage(
                `${t('rclone installation failed.')}\n${error.message}\n${t('If you are offline, download rclone.exe yourself and set tosRemote.rclonePath.')}`,
                openSettings
            );
            if (pick === openSettings) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'tosRemote.rclonePath');
            }
            return undefined;
        }
    }

    // winget으로 설치 (UAC 승인 필요). winget이 없으면 공식 다운로드 페이지를 연다.
    async installWinFsp() {
        const winget = findExecutable('winget.exe');
        if (!winget) {
            vscode.window.showInformationMessage(t('winget is not available, so the WinFsp download page will open. Try again in VS Code after installing.'));
            await vscode.env.openExternal(vscode.Uri.parse(WINFSP_RELEASES));
            return;
        }
        const task = new vscode.Task(
            { type: 'tos-remote', file: 'winfsp-install' },
            vscode.TaskScope.Global,
            t('Install WinFsp'),
            'tOS',
            new vscode.ProcessExecution(winget, ['install', '--id', 'WinFsp.WinFsp', '-e', '--accept-source-agreements', '--accept-package-agreements']),
            []
        );
        task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, focus: true };
        const execution = await vscode.tasks.executeTask(task);
        await new Promise((resolve) => {
            const listener = vscode.tasks.onDidEndTaskProcess((event) => {
                if (event.execution === execution) {
                    listener.dispose();
                    resolve();
                }
            });
        });
        const state = await this.refresh();
        if (state.winfsp) {
            vscode.window.showInformationMessage(t('WinFsp installation confirmed.'));
        } else {
            const openPage = t('Open Download Page');
            const pick = await vscode.window.showWarningMessage(t('Could not confirm the WinFsp installation. Make sure you approved the installer (UAC).'), openPage);
            if (pick === openPage) {
                vscode.env.openExternal(vscode.Uri.parse(WINFSP_RELEASES));
            }
        }
    }

    static isSupportedUv(version) {
        return !!version && compareVersions(version, MIN_UV_VERSION) >= 0;
    }

    /**
     * 보드용 패키지 해석에 쓰는 uv를 준비한다 (PyPI에서 SHA-256 검증 후 확장 저장소에 설치, 업데이트하지 않음).
     * @returns {Promise<string>} uv.exe 경로
     */
    async ensureUv(options = {}) {
        let version = await getUvVersion(this.uvExePath());
        if (Prerequisites.isSupportedUv(version)) {
            return this.uvExePath();
        }
        if (!options.interactive) {
            throw new Error(t('uv is not installed. Install it from the tOS Remote panel.'));
        }
        const download = t('Download');
        const pick = await vscode.window.showWarningMessage(
            t('Installing packages on the board requires uv (about 15 MB), which resolves packages for the board on this PC. The first time, uv also downloads a Python runtime for resolution (about 21 MB). Download uv now?'),
            { modal: true },
            download
        );
        if (pick !== download) {
            throw new vscode.CancellationError();
        }
        const result = await this.installUv();
        version = result && result.version;
        if (!Prerequisites.isSupportedUv(version)) {
            throw new Error(t('uv is not ready yet.'));
        }
        return this.uvExePath();
    }

    async installUv() {
        const installed = await getUvVersion(this.uvExePath());
        if (Prerequisites.isSupportedUv(installed)) {
            await this.refresh();
            return { version: installed, exePath: this.uvExePath() };
        }
        try {
            const result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Installing uv')
            }, (progress) => installUv({
                binDir: this.binDir,
                logger: this.log,
                onProgress: (message) => progress.report({ message })
            }));
            vscode.window.showInformationMessage(t('uv {0} installed.', result.version));
            await this.refresh();
            return result;
        } catch (error) {
            this.log.error(`uv install failed: ${error.message}`);
            vscode.window.showErrorMessage(`${t('uv installation failed.')}\n${error.message}`);
            return undefined;
        }
    }

    dispose() {
        this.emitter.dispose();
    }
}

module.exports = { Prerequisites };
