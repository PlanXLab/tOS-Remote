'use strict';

const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');
const { shellQuote, lastLine } = require('./util');
const { buildDebugScript, DEBUG_READY, DEBUG_FAILED } = require('./debugScript');
const { t } = require('./i18n');

const TASK_SOURCE = 'tOS';

class Runner {
    constructor(sessionMgr, ssh, log) {
        this.sessionMgr = sessionMgr;
        this.ssh = ssh;
        this.log = log;
        this.debugChild = undefined;
    }

    /** 로컬 파일 → 보드 작업 공간 기준 상대 경로 */
    resolveTarget(uri) {
        if (!this.sessionMgr.isOwnerWindow()) {
            throw new Error(t('This can only run in the remote workspace window.'));
        }
        const session = this.sessionMgr.readSession();
        if (!session) {
            throw new Error(t('Remote workspace information is missing. Reopen the workspace.'));
        }
        if (!uri || uri.scheme !== 'file') {
            throw new Error(t('Open a Python file in the editor first.'));
        }
        const root = `${session.drive}\\`;
        const relative = path.relative(root, uri.fsPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(t('Files outside the remote workspace ({0}) cannot be run: {1}', session.drive, uri.fsPath));
        }
        return { session, relativePath: relative.split(path.sep).join('/') };
    }

    async prepare(uri) {
        const target = this.resolveTarget(uri);
        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (document && document.isDirty) {
            await document.save();
        }
        // VFS 쓰기 지연 때문에 저장 직후 보드에 이전 파일이 남아 있을 수 있어 업로드 완료를 기다린다
        const flushed = await this.sessionMgr.waitForUploads(15000);
        if (!flushed) {
            throw new Error(t('Uploading files to the board has not finished. Try again in a moment.'));
        }
        return target;
    }

    sshArgs(session, batch) {
        const target = { host: session.host, port: session.port, user: session.user };
        return this.ssh.baseArgs(target, { keyPath: session.authType === 'key' ? session.keyPath : undefined, batch });
    }

    async runFile(uri) {
        const fileUri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
        try {
            const { session, relativePath } = await this.prepare(fileUri);
            await this.runRemote(session, relativePath);
        } catch (error) {
            vscode.window.showErrorMessage(error.message);
        }
    }

    // Run 버튼 메뉴용. 선택된 launch 구성과 관계없이 항상 보드에서 디버깅한다.
    async debugFile(uri) {
        const fileUri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
        if (!fileUri) {
            vscode.window.showErrorMessage(t('Open a Python file in the editor first.'));
            return false;
        }
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        return vscode.debug.startDebugging(folder, {
            type: 'tos-remote',
            request: 'launch',
            name: `tOS: ${path.basename(fileUri.fsPath)}`,
            program: fileUri.fsPath,
            justMyCode: true
        });
    }

    async runRemote(session, relativePath) {
        const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const command = `cd ${shellQuote(session.remoteWorkspace)} && ${session.pythonCommand || 'python3'} -u ${shellQuote(relativePath)}`;
        const task = new vscode.Task(
            { type: 'tos-remote', file: relativePath },
            folder || vscode.TaskScope.Workspace,
            t('Run on tOS: {0}', relativePath),
            TASK_SOURCE,
            new vscode.ProcessExecution(this.ssh.sshPath, [...this.sshArgs(session, false), '-t', `${session.user}@${session.host}`, command]),
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            focus: true,
            clear: true
        };
        await vscode.tasks.executeTask(task);
    }

    // ---------------------------------------------------------------- 원격 디버그

    startDebuggee(session, relativePath, token) {
        this.stopDebuggee(false);
        const port = session.debugPort || 5678;
        const script = buildDebugScript({
            remoteWorkspace: session.remoteWorkspace,
            pythonCommand: session.pythonCommand || 'python3',
            relativePath,
            port
        });
        const args = [...this.sshArgs(session, true), `${session.user}@${session.host}`, 'sh -s'];
        const child = spawn(this.ssh.sshPath, args, { windowsHide: true });
        this.debugChild = child;
        child.stdin.on('error', () => {});
        child.stdin.end(script);

        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let settled = false;
            const finish = (error) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                if (error) {
                    this.stopDebuggee(true);
                    reject(error);
                } else {
                    resolve(port);
                }
            };
            const timer = setTimeout(() => finish(new Error(t('Timed out starting the remote debugger (debugpy).'))), 30000);
            if (token) {
                token.onCancellationRequested(() => finish(new Error(t('Debugging was canceled.'))));
            }
            child.stdout.on('data', (data) => {
                if (settled) {
                    return;
                }
                stdout += data.toString('utf8');
                if (stdout.includes(DEBUG_READY)) {
                    finish();
                } else if (stdout.includes(DEBUG_FAILED)) {
                    finish(new Error(t('Could not start debugpy: {0}', lastLine(stderr) || t('Check that debugpy is installed on the board.'))));
                }
            });
            child.stderr.on('data', (data) => {
                const text = data.toString('utf8');
                stderr = (stderr + text).slice(-8192);
                this.log.debug(`[debugpy] ${text.trimEnd()}`);
            });
            child.on('error', (error) => finish(error));
            child.on('close', (code) => {
                if (this.debugChild === child) {
                    this.debugChild = undefined;
                }
                finish(new Error(t('The remote process exited (exit {0}): {1}', code, lastLine(stderr))));
            });
        });
    }

    stopDebuggee(killRemote) {
        const child = this.debugChild;
        this.debugChild = undefined;
        if (child && child.exitCode === null) {
            child.kill();
            killRemote = true;
        }
        if (killRemote) {
            const session = this.sessionMgr.readSession();
            if (session && session.authType === 'key') {
                this.ssh.exec({ host: session.host, port: session.port, user: session.user }, 'pkill -u "$(id -u)" -f debugpy', { keyPath: session.keyPath, timeoutMs: 10000 })
                    .catch((error) => this.log.debug(`debugpy cleanup failed: ${error.message}`));
            }
        }
    }

    dispose() {
        this.stopDebuggee(false);
    }
}

class DebugConfigurationProvider {
    constructor(runner, sessionMgr) {
        this.runner = runner;
        this.sessionMgr = sessionMgr;
    }

    programUri(program, folder) {
        if (!program || program === '${file}') {
            const editor = vscode.window.activeTextEditor;
            return editor ? editor.document.uri : undefined;
        }
        let resolved = String(program);
        if (folder) {
            resolved = resolved.split('${workspaceFolder}').join(folder.uri.fsPath);
        }
        if (/\$\{/.test(resolved)) {
            throw new Error(t('Unsupported variable: {0} (only ${file} and ${workspaceFolder} are supported)', program));
        }
        return vscode.Uri.file(resolved);
    }

    async resolveDebugConfiguration(folder, config, token) {
        if (!config.type && !config.request && !config.name) {
            config = { type: 'tos-remote', request: 'launch', name: t('tOS: Current File'), program: '${file}' };
        }
        try {
            const uri = this.programUri(config.program, folder);
            const { session, relativePath } = await this.runner.prepare(uri);

            // Ctrl+F5: 디버거 없이 SSH 터미널에서 실행하고 디버그 세션은 시작하지 않는다
            if (config.noDebug) {
                await this.runner.runRemote(session, relativePath);
                return undefined;
            }
            if (session.authType !== 'key') {
                const register = t('Register SSH Key');
                vscode.window.showErrorMessage(t('Remote debugging (F5) requires SSH key authentication. Run without debugging (Ctrl+F5) also works with a password.'), register)
                    .then((pick) => pick === register && vscode.commands.executeCommand('tosRemote.setupSshKey'));
                return undefined;
            }
            if (!vscode.extensions.getExtension('ms-python.debugpy')) {
                const install = t('Install');
                vscode.window.showErrorMessage(t('The Python Debugger extension (ms-python.debugpy) is required.'), install)
                    .then((pick) => pick === install && vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-python.debugpy'));
                return undefined;
            }

            const port = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: t('Starting the remote debugger')
            }, () => this.runner.startDebuggee(session, relativePath, token));

            return {
                type: 'debugpy',
                request: 'attach',
                name: config.name || `tOS: ${relativePath}`,
                connect: { host: session.host, port },
                pathMappings: this.sessionMgr.getPathMappings().map((m) => ({ localRoot: m.local, remoteRoot: m.remote })),
                redirectOutput: true,
                justMyCode: config.justMyCode !== false,
                tosRemote: true
            };
        } catch (error) {
            vscode.window.showErrorMessage(error.message);
            return undefined;
        }
    }
}

module.exports = { Runner, DebugConfigurationProvider, TASK_SOURCE };
