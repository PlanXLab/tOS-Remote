'use strict';

const path = require('path');
const vscode = require('vscode');
const { shellQuote, lastLine, writeIfChanged, getFreePort } = require('./util');
const { buildDebugScript, DEBUG_READY, DEBUG_FAILED, DEBUGPY_MISSING } = require('./debugScript');
const { buildRunScript, runScriptEnv } = require('./sshTerminal');
const { t } = require('./i18n');

const TASK_SOURCE = 'tOS';

class Runner {
    constructor(sessionMgr, ssh, log) {
        this.sessionMgr = sessionMgr;
        this.ssh = ssh;
        this.log = log;
        this.debugChild = undefined;
        // 보드에 debugpy가 없을 때 설치 (extension.js에서 연결)
        this.boardTools = undefined;
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
        const root = session.localWorkspace ? path.normalize(session.localWorkspace) : `${session.drive}\\`;
        const relative = path.relative(root, uri.fsPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(t('Files outside the remote workspace ({0}) cannot be run: {1}', root, uri.fsPath));
        }
        return { session, relativePath: relative.split(path.sep).join('/') };
    }

    async prepare(uri) {
        const target = this.resolveTarget(uri);
        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        if (document && document.isDirty) {
            await document.save();
        }
        // Watcher notification can lag behind save; enqueue this file without rescanning the entire workspace.
        if (this.sessionMgr.syncer) {
            this.sessionMgr.syncer.enqueueChange('copy', uri.fsPath);
        }
        const flushed = this.sessionMgr.syncer
            ? (await this.sessionMgr.syncer.flush(15000, { scan: false }))
            : (await this.sessionMgr.waitForUploads(15000));
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
        // 터미널에는 프로그램 출력만 보이도록 ssh 명령줄을 배치 파일 + 환경 변수로 넘긴다 (echo 끔, 종료 코드 0)
        const script = path.join(this.sessionMgr.storageDir, 'run-on-tos.cmd');
        writeIfChanged(script, buildRunScript());
        const sshArgs = [...this.sshArgs(session, false), '-t', `${session.user}@${session.host}`, command];
        const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
        const task = new vscode.Task(
            { type: 'tos-remote', file: relativePath },
            folder || vscode.TaskScope.Workspace,
            t('Run on tOS: {0}', relativePath),
            TASK_SOURCE,
            new vscode.ProcessExecution(cmd, ['/d', '/c', script], { env: runScriptEnv(this.ssh.sshPath, sshArgs) }),
            []
        );
        task.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            focus: true,
            clear: true,
            echo: false,
            showReuseMessage: false
        };
        await vscode.tasks.executeTask(task);
    }

    // ---------------------------------------------------------------- 원격 디버그

    /**
     * @param {{keyPath?: string, password?: string}} sshAuth
     * @returns {Promise<number>} PC 로컬 포워딩 포트. debugpy가 없으면 error.code === 'DEBUGPY_MISSING'
     */
    async startDebuggee(session, relativePath, token, sshAuth) {
        this.stopDebuggee(false);
        const remotePort = session.debugPort || 5678;
        const localPort = await getFreePort();
        const script = buildDebugScript({
            remoteWorkspace: session.remoteWorkspace,
            pythonCommand: session.pythonCommand || 'python3',
            relativePath,
            port: remotePort
        });
        const target = { host: session.host, port: session.port, user: session.user };
        // SSH 로컬 포트 포워딩 (-L 127.0.0.1:localPort:127.0.0.1:remotePort)
        const sshArgs = ['-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`];
        const child = await this.ssh.spawn(target, ['sh -s'], { ...sshAuth, sshArgs });
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
                    resolve(localPort);
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
                } else if (stdout.includes(DEBUGPY_MISSING)) {
                    const error = new Error(t('debugpy is not installed on the board.'));
                    error.code = 'DEBUGPY_MISSING';
                    finish(error);
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
            if (session) {
                const target = { host: session.host, port: session.port, user: session.user };
                this.sessionMgr.sshAuth(session)
                    .then((auth) => this.ssh.exec(target, 'pkill -u "$(id -u)" -f debugpy', { ...auth, timeoutMs: 10000 }))
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
            if (!vscode.extensions.getExtension('ms-python.debugpy')) {
                const install = t('Install');
                vscode.window.showErrorMessage(t('The Python Debugger extension (ms-python.debugpy) is required.'), install)
                    .then((pick) => pick === install && vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-python.debugpy'));
                return undefined;
            }
            // 키 인증이 아니면 저장된 비밀번호를 SSH_ASKPASS로 넘긴다 (없으면 한 번 입력)
            const sshAuth = await this.sessionMgr.sshAuth(session, { interactive: true });
            const start = () => vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Preparing debug on tOS')
            }, () => this.runner.startDebuggee(session, relativePath, token, sshAuth));

            let localPort;
            try {
                localPort = await start();
            } catch (error) {
                if (error.code !== 'DEBUGPY_MISSING' || !this.runner.boardTools) {
                    throw error;
                }
                // debugpy가 없으면 PC에서 내려받아 보드 전역 환경에 설치한 뒤 다시 시작한다
                const install = t('Install debugpy');
                const pick = await vscode.window.showWarningMessage(
                    t('debugpy is not installed on the board. Install it now? The package is downloaded on this PC and copied to the board (sudo password may be required).'),
                    { modal: true },
                    install
                );
                if (pick !== install || !(await this.runner.boardTools.install('debug')) || (token && token.isCancellationRequested)) {
                    return undefined;
                }
                localPort = await start();
            }

            return {
                type: 'debugpy',
                request: 'attach',
                name: config.name || `tOS: ${relativePath}`,
                connect: { host: '127.0.0.1', port: localPort },
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
