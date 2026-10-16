'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const {
    installRclone, installUv, getUvVersion, getRclonePackageManager, rcloneExecutableName, uvExecutableName
} = require('./installer');
const { Rclone, MIN_VERSION, compareVersions } = require('./rclone');
const { getSettings } = require('./settings');
const { findExecutable, findExecutables } = require('./util');
const { t } = require('./i18n');

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
        this.state = context.globalState.get(PREREQ_STATE_KEY) || { ssh: false, rcloneVersion: undefined };
        this.checked = false;
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
    }

    rcloneExePath() {
        const configured = getSettings().rclonePath;
        if (configured) {
            return configured;
        }
        const local = path.join(this.binDir, rcloneExecutableName());
        return this.resolvedRclonePath || (fs.existsSync(local) ? local : (findExecutable(rcloneExecutableName()) || local));
    }

    uvExePath() {
        const executable = uvExecutableName();
        const local = path.join(this.binDir, executable);
        return this.resolvedUvPath || (fs.existsSync(local) ? local : (findExecutable(executable) || local));
    }

    async resolveExecutable(name, getVersion, isSupported) {
        const local = path.join(this.binDir, name);
        const candidates = [...new Set([local, ...findExecutables(name)])];
        let firstInstalled;
        for (const exePath of candidates) {
            if (!fs.existsSync(exePath)) {
                continue;
            }
            const version = await getVersion(exePath);
            if (!firstInstalled) {
                firstInstalled = { exePath, version };
            }
            if (isSupported(version)) {
                return { exePath, version };
            }
            this.log.warn(`Unsupported or unusable ${name}: ${exePath} (${version || 'version check failed'})`);
        }
        return firstInstalled || { exePath: local, version: undefined };
    }

    async resolveRclone() {
        const configured = getSettings().rclonePath;
        if (configured) {
            this.resolvedRclonePath = undefined;
            return this.rclone.getVersion(configured);
        }
        const result = await this.resolveExecutable(rcloneExecutableName(),
            (exe) => this.rclone.getVersion(exe), Rclone.isSupportedVersion);
        this.resolvedRclonePath = result.exePath;
        return result.version;
    }

    async resolveUv() {
        const result = await this.resolveExecutable(uvExecutableName(), getUvVersion, Prerequisites.isSupportedUv);
        this.resolvedUvPath = result.exePath;
        return result.version;
    }

    async refresh() {
        const [rcloneVersion, uvVersion] = await Promise.all([this.resolveRclone(), this.resolveUv()]);
        this.state = { ssh: !!this.ssh.sshPath, rcloneVersion, uvVersion };
        this.checked = true;
        this.emitter.fire(this.state);
        await Promise.all([
            this.context.globalState.update(PREREQ_STATE_KEY, this.state),
            vscode.commands.executeCommand('setContext', 'tosRemote.rcloneReady', Rclone.isSupportedVersion(rcloneVersion)),
            vscode.commands.executeCommand('setContext', 'tosRemote.sshReady', this.state.ssh)
        ]);
        return this.state;
    }

    async ensureAll(options = {}) {
        let state = await this.refresh();
        if (!state.ssh) {
            if (options.interactive) {
                if (process.platform === 'win32') {
                    const howTo = t('How to Install');
                    const pick = await vscode.window.showErrorMessage(t('The OpenSSH client (ssh.exe) is required. Add "OpenSSH Client" in Windows Settings > System > Optional features.'), howTo);
                    if (pick === howTo) {
                        vscode.env.openExternal(vscode.Uri.parse(OPENSSH_DOCS));
                    }
                } else {
                    vscode.window.showErrorMessage(t('The OpenSSH client (ssh) was not found. Install OpenSSH using your operating system package manager.'));
                }
            }
            throw new Error(t('The OpenSSH client (ssh) was not found.'));
        }

        if (!Rclone.isSupportedVersion(state.rcloneVersion)) {
            const reason = state.rcloneVersion
                ? t('rclone {0} is not supported (minimum {1}).', state.rcloneVersion, MIN_VERSION)
                : t('rclone is not ready yet.');
            if (options.interactive && !getSettings().rclonePath) {
                const install = t('Install');
                const pick = await vscode.window.showWarningMessage(`${reason} ${t('Install a supported version of rclone now?')}`, { modal: true }, install);
                if (pick === install) {
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

    async installRclone(options = {}) {
        if (getSettings().rclonePath) {
            vscode.window.showInformationMessage(t('tosRemote.rclonePath ({0}) is set, so automatic installation is disabled.', getSettings().rclonePath));
            return undefined;
        }
        // 한 번 설치한 rclone은 다시 내려받지 않는다 (업데이트 기능 없음)
        const installed = await this.resolveRclone();
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
            let result;
            const manager = options.usePackageManager === false ? undefined : getRclonePackageManager();
            if (manager) {
                let exitCode;
                let startError;
                try {
                    exitCode = await this.runPackageManager(manager);
                } catch (error) {
                    startError = error;
                    this.log.error(`${manager.label} could not start: ${error.message}`);
                }
                await this.refresh();
                const version = this.state.rcloneVersion;
                if (exitCode === 0 && Rclone.isSupportedVersion(version)) {
                    result = { version, exePath: this.rcloneExePath() };
                    vscode.window.showInformationMessage(t('rclone {0} installed with {1}.', version, manager.label));
                    return result;
                }
                const download = t('Download verified release');
                let reason;
                if (startError) {
                    reason = t('Could not start {0}: {1}', manager.label, startError.message);
                } else if (exitCode === undefined) {
                    reason = t('The {0} installation was cancelled.', manager.label);
                } else if (exitCode !== 0) {
                    reason = t('{0} exited with code {1}.', manager.label, exitCode);
                } else {
                    reason = t('The {0} package manager did not provide a supported rclone version.', manager.label);
                }
                const pick = await vscode.window.showWarningMessage(
                    `${reason} ${t('Download the verified official release instead?')}`,
                    { modal: true },
                    download
                );
                if (pick !== download) {
                    return undefined;
                }
            }
            result = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Installing rclone')
            }, (progress) => installRclone({
                binDir: this.binDir,
                logger: this.log,
                onProgress: (message) => progress.report({ message })
            }));
            await this.refresh();
            if (!Rclone.isSupportedVersion(this.state.rcloneVersion)) {
                throw new Error(t('rclone is not ready yet.'));
            }
            vscode.window.showInformationMessage(t('rclone {0} installed.', result.version));
            return result;
        } catch (error) {
            this.log.error(`rclone install failed: ${error.message}`);
            const openSettings = t('Open Settings');
            const pick = await vscode.window.showErrorMessage(
                `${t('rclone installation failed.')}\n${error.message}\n${t('If automatic installation is unavailable, set tosRemote.rclonePath to an rclone executable you already have.')}`,
                openSettings
            );
            if (pick === openSettings) {
                vscode.commands.executeCommand('workbench.action.openSettings', 'tosRemote.rclonePath');
            }
            return undefined;
        }
    }

    runPackageManager(manager) {
        let command = manager.command;
        let args = manager.args;
        let shell = !!manager.shell;
        if (manager.requiresSudo && process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0)) {
            const sudo = findExecutable('sudo');
            if (sudo) {
                command = sudo;
                args = [manager.command, ...manager.args];
                shell = false;
            }
        }
        const executionOptions = { cwd: os.homedir() };
        const execution = shell
            ? new vscode.ShellExecution(command, args, {
                ...executionOptions,
                executable: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
                shellArgs: ['/d', '/c']
            })
            : new vscode.ProcessExecution(command, args, executionOptions);
        const task = new vscode.Task(
            { type: 'tosRemote.installRclone', manager: manager.label },
            vscode.TaskScope.Global,
            t('Install rclone with {0}', manager.label),
            'tOS Remote',
            execution,
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Dedicated,
            focus: true,
            echo: true,
            clear: false,
            showReuseMessage: true
        };
        return new Promise((resolve, reject) => {
            let settled = false;
            let taskExecution;
            const pending = [];
            const finish = (code, error) => {
                if (settled) {
                    return;
                }
                settled = true;
                processListener.dispose();
                taskListener.dispose();
                if (error) {
                    reject(error);
                } else {
                    resolve(code);
                }
            };
            const ended = (execution, exitCode) => {
                if (!taskExecution) {
                    pending.push({ execution, exitCode });
                } else if (execution === taskExecution) {
                    finish(exitCode);
                }
            };
            const processListener = vscode.tasks.onDidEndTaskProcess((event) => {
                ended(event.execution, event.exitCode);
            });
            const taskListener = vscode.tasks.onDidEndTask((event) => {
                ended(event.execution, undefined);
            });
            vscode.tasks.executeTask(task).then((execution) => {
                taskExecution = execution;
                for (const event of pending) {
                    ended(event.execution, event.exitCode);
                }
            }, (error) => finish(undefined, error));
        });
    }

    static isSupportedUv(version) {
        return !!version && compareVersions(version, MIN_UV_VERSION) >= 0;
    }

    /**
     * 보드용 패키지 해석에 쓰는 기존 uv를 재사용하고 없으면 확장 저장소에 설치한다.
     * @returns {Promise<string>} uv 실행 파일 경로
     */
    async ensureUv(options = {}) {
        let version = await this.resolveUv();
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
        const installed = await this.resolveUv();
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
            await this.refresh();
            if (!Prerequisites.isSupportedUv(this.state.uvVersion)) {
                throw new Error(t('uv is not ready yet.'));
            }
            vscode.window.showInformationMessage(t('uv {0} installed.', result.version));
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
