'use strict';

// 보드 Jupyter 서버 관리: 보드에서 백그라운드로 시작(127.0.0.1, 토큰) → PC에서 SSH 포트 포워딩 →
// VS Code Jupyter 확장의 커널 선택기에 "tOS Remote" 서버로 등록한다. #%% 셀 실행은 Jupyter 확장이 처리한다.
const net = require('net');
const http = require('http');
const vscode = require('vscode');
const scripts = require('./boardScripts');
const { getFreePort, randomToken, sleep, lastLine } = require('./util');
const { baseControllerId, controllerIdFor, boardKey, KERNEL_NOTEBOOK_TYPES } = require('./jupyterKernel');
const { t } = require('./i18n');

const JUPYTER_EXTENSION_ID = 'ms-toolsai.jupyter';
const COLLECTION_ID = 'tos-remote';
const SERVER_ID = 'tos-remote';
const TUNNEL_TIMEOUT_MS = 20000;
const RECONNECT_DELAYS_MS = [2000, 5000, 15000, 30000];
const KERNEL_IDS_KEY = 'tosRemote.jupyterKernelIds';
// 서버를 막 시작했을 때 Jupyter 확장이 커널 목록을 가져와 컨트롤러를 만들 때까지 기다리는 시간
const SELECT_ATTEMPTS = 20;
const SELECT_INTERVAL_MS = 500;
const PREPARE_RETRY_MS = 60000;

/** 포워딩된 Jupyter REST API 요청 (토큰 인증) */
function jupyterRequest(port, token, method, pathName, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port,
            path: pathName,
            method,
            timeout: timeoutMs,
            headers: { Authorization: `token ${token}` }
        }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', reject);
        request.end();
    });
}

function isPortFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
}

const { maskToken } = scripts;

class JupyterManager {
    /**
     * @param {{log: vscode.LogOutputChannel, ssh: any, sessionMgr: any, boardTools: any}} services
     */
    constructor(services) {
        Object.assign(this, services);
        this.state = { phase: 'stopped' };
        this.tunnel = undefined;
        this.collection = undefined;
        this.disposed = false;
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
        this.serversEmitter = new vscode.EventEmitter();
        this.kernelHandled = new Set();
        this.lastPrepareFailure = 0;
    }

    status() {
        return {
            phase: this.state.phase,
            localPort: this.tunnel && this.tunnel.localPort,
            error: this.state.error,
            extensionInstalled: !!vscode.extensions.getExtension(JUPYTER_EXTENSION_ID)
        };
    }

    setState(patch) {
        this.state = { ...this.state, ...patch };
        this.emitter.fire(this.status());
        this.serversEmitter.fire();
    }

    get running() {
        return this.state.phase === 'running' && !!this.tunnel;
    }

    /** 보드 Python으로 Jupyter 제어 스크립트를 실행한다. */
    async runScript(session, auth, action, extra = {}) {
        const probe = await this.boardTools.ensureProbe();
        const target = { host: session.host, port: session.port, user: session.user };
        const result = await this.ssh.exec(target, 'sh -s', {
            ...auth,
            input: scripts.buildJupyterScript(action, { python: probe.python, remoteWorkspace: session.remoteWorkspace, ...extra }),
            timeoutMs: action === 'start' ? 150000 : 30000
        });
        if (action === 'log') {
            return result;
        }
        const parsed = scripts.parseJupyterOutput(result.stdout);
        if (parsed.state === 'unknown') {
            throw new Error(lastLine(result.stderr) || `exit ${result.code}`);
        }
        return parsed;
    }

    saveHint(session, port) {
        this.sessionMgr.updateSession({ jupyter: port ? { port } : undefined }, session.identity);
    }

    /**
     * 보드에서 Jupyter 서버를 시작(이미 실행 중이면 연결)하고 SSH 포트 포워딩을 연다.
     * @param {{interactive?: boolean, fromKernelPicker?: boolean}} options
     */
    start(options = {}) {
        if (this.running) {
            if (options.interactive !== false && !options.fromKernelPicker) {
                this.showRunningMessage();
            }
            return Promise.resolve(true);
        }
        if (!this.starting) {
            this.starting = this.doStart(options).finally(() => {
                this.starting = undefined;
            });
        }
        return this.starting;
    }

    async doStart(options) {
        const interactive = options.interactive !== false;
        try {
            const session = this.boardTools.requireSession();
            const probe = await this.boardTools.ensureProbe({ interactive });
            if (!scripts.toolStatus(probe).jupyter.ready) {
                throw new Error(t('Jupyter is not installed on the board. Install it from the tOS Remote panel when you need it.'));
            }
            this.setState({ phase: 'starting', error: undefined });
            const auth = await this.sessionMgr.sshAuth(session, { interactive });
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Window,
                title: t('Starting Jupyter on tOS')
            }, async () => {
                const remote = await this.runScript(session, auth, 'start', { token: randomToken(24) });
                if (remote.state === 'missing') {
                    throw new Error(t('Jupyter is not installed on the board. Install it from the tOS Remote panel when you need it.'));
                }
                if (remote.state !== 'running' && remote.state !== 'started') {
                    throw new Error(t('The Jupyter server did not start on the board: {0}', maskToken(remote.message || remote.state)));
                }
                this.log.info(`Jupyter server on the board: pid ${remote.pid}, port ${remote.port} (${remote.state})`);
                await this.openTunnel(session, auth, remote);
            });
            this.saveHint(session, this.state.remotePort);
            this.setState({ phase: 'running', error: undefined });
            await this.registerCollection();
            if (interactive && !options.fromKernelPicker) {
                this.showRunningMessage();
            }
            return true;
        } catch (error) {
            this.closeTunnel();
            this.setState({ phase: 'stopped', error: error.message });
            if (interactive && !(error instanceof vscode.CancellationError)) {
                await this.sessionMgr.reportError(t('Could not start Jupyter on tOS.'), error);
            } else {
                this.log.warn(`Jupyter start failed: ${error.message}`);
            }
            return false;
        }
    }

    /** PC 127.0.0.1:<빈 포트> → 보드 127.0.0.1:<서버 포트> 포워딩을 열고 API 응답을 확인한다. */
    async openTunnel(session, auth, remote) {
        const preferred = this.state.localPort;
        const localPort = preferred && (await isPortFree(preferred)) ? preferred : await getFreePort();
        const target = { host: session.host, port: session.port, user: session.user };
        const child = await this.ssh.spawn(target, [], {
            ...auth,
            sshArgs: ['-n', '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remote.port}`]
        });
        let stderr = '';
        let exited = false;
        child.stderr.on('data', (data) => {
            stderr = (stderr + data.toString('utf8')).slice(-4096);
        });
        child.once('close', (code) => {
            exited = true;
            this.onTunnelClosed(child, code, stderr);
        });
        child.once('error', () => {
            exited = true;
        });
        const deadline = Date.now() + TUNNEL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            if (exited) {
                throw new Error(t('The SSH tunnel for Jupyter closed: {0}', lastLine(stderr) || t('unknown error')));
            }
            const response = await jupyterRequest(localPort, remote.token, 'GET', '/api/status', 3000).catch(() => undefined);
            if (response && response.status === 200) {
                this.tunnel = { child, localPort };
                this.state = { ...this.state, token: remote.token, remotePort: remote.port, localPort };
                this.log.info(`Jupyter tunnel: 127.0.0.1:${localPort} → board 127.0.0.1:${remote.port}`);
                return;
            }
            if (response && (response.status === 401 || response.status === 403)) {
                child.kill();
                throw new Error(t('The Jupyter server on the board rejected the token. Stop the server and start it again.'));
            }
            await sleep(300);
        }
        child.kill();
        throw new Error(t('Timed out connecting to the Jupyter server on the board.'));
    }

    closeTunnel() {
        const tunnel = this.tunnel;
        this.tunnel = undefined;
        if (tunnel && tunnel.child.exitCode === null) {
            tunnel.child.kill();
        }
    }

    // 포워딩이 끊기면(네트워크·보드 재시작) 서버가 살아 있는 동안 다시 연결한다
    async onTunnelClosed(child, code, stderr) {
        if (!this.tunnel || this.tunnel.child !== child) {
            return;
        }
        this.tunnel = undefined;
        if (this.disposed || this.state.phase !== 'running') {
            return;
        }
        this.log.warn(`Jupyter tunnel closed (exit ${code}): ${lastLine(stderr)}`);
        this.setState({ phase: 'reconnecting' });
        for (const delay of RECONNECT_DELAYS_MS) {
            await sleep(delay);
            if (this.disposed || this.state.phase !== 'reconnecting') {
                return;
            }
            try {
                const session = this.boardTools.requireSession();
                const auth = await this.sessionMgr.sshAuth(session);
                const remote = await this.runScript(session, auth, 'status');
                if (remote.state !== 'running') {
                    this.saveHint(session, undefined);
                    this.setState({ phase: 'stopped', error: t('The Jupyter server on the board has stopped.') });
                    return;
                }
                await this.openTunnel(session, auth, remote);
                this.setState({ phase: 'running', error: undefined });
                return;
            } catch (error) {
                this.log.warn(`Jupyter reconnect failed: ${error.message}`);
            }
        }
        this.setState({ phase: 'stopped', error: t('Lost the connection to the Jupyter server on the board.') });
    }

    /**
     * 이 확장이 시작한 보드 Jupyter 서버를 끝내고 포워딩을 닫는다 (커널도 함께 종료).
     * @param {{quiet?: boolean}} options quiet: 작업 공간을 닫을 때처럼 알림 없이
     */
    async stop(options = {}) {
        const session = this.boardTools.currentSession();
        const hint = session && session.jupyter;
        if (!session || (this.state.phase === 'stopped' && !this.tunnel && !hint)) {
            this.closeTunnel();
            if (!options.quiet && session) {
                vscode.window.showInformationMessage(t('Jupyter is not running on tOS.'));
            }
            return;
        }
        const token = this.state.token;
        const tunnel = this.tunnel;
        this.setState({ phase: 'stopping' });
        try {
            if (tunnel && token) {
                await jupyterRequest(tunnel.localPort, token, 'POST', '/api/shutdown', 5000).catch(() => undefined);
            }
            const auth = await this.sessionMgr.sshAuth(session);
            await this.runScript(session, auth, 'stop');
            this.log.info('Jupyter server on the board stopped');
            if (!options.quiet) {
                vscode.window.setStatusBarMessage(t('tOS: Jupyter stopped.'), 4000);
            }
        } catch (error) {
            if (options.quiet) {
                this.log.warn(`Jupyter stop failed: ${error.message}`);
            } else {
                await this.sessionMgr.reportError(t('Could not stop Jupyter on tOS.'), error);
            }
        } finally {
            this.closeTunnel();
            this.saveHint(session, undefined);
            this.state = { phase: 'stopped' };
            this.setState({});
        }
    }

    /** 원격 작업 공간 창이 열릴 때: 이전에 시작한 서버가 실행 중이면 다시 연결한다. */
    attach() {
        if (!this.attaching) {
            this.attaching = this.doAttach().finally(() => {
                this.attaching = undefined;
            });
        }
        return this.attaching;
    }

    async doAttach() {
        const session = this.boardTools.currentSession();
        if (!session || !session.jupyter || this.state.phase !== 'stopped') {
            return;
        }
        try {
            const auth = await this.sessionMgr.sshAuth(session);
            const remote = await this.runScript(session, auth, 'status');
            if (remote.state !== 'running') {
                this.saveHint(session, undefined);
                return;
            }
            this.setState({ phase: 'starting' });
            await this.openTunnel(session, auth, remote);
            this.setState({ phase: 'running', error: undefined });
            await this.registerCollection();
        } catch (error) {
            this.closeTunnel();
            this.setState({ phase: 'stopped', error: error.message });
            this.log.warn(`Jupyter reattach failed: ${error.message}`);
        }
    }

    /** 보드의 Jupyter 서버 로그를 출력 채널에 표시한다 (토큰은 가린다). */
    async showLog() {
        try {
            const session = this.boardTools.requireSession();
            const auth = await this.sessionMgr.sshAuth(session, { interactive: true });
            const result = await this.runScript(session, auth, 'log');
            const text = maskToken(result.stdout.trim(), this.state.token);
            this.log.info(`--- Jupyter server log on the board (last 200 lines)\n${text || '(empty)'}`);
            this.log.show();
        } catch (error) {
            await this.sessionMgr.reportError(t('Could not read the Jupyter log on the board.'), error);
        }
    }

    /** Jupyter 확장의 커널 선택기에 "tOS Remote" 서버 모음을 등록한다 (Jupyter 확장이 있을 때). */
    async registerCollection() {
        if (this.collection || this.registering || this.disposed || !this.sessionMgr.isOwnerWindow()) {
            return;
        }
        const extension = vscode.extensions.getExtension(JUPYTER_EXTENSION_ID);
        if (!extension) {
            return;
        }
        this.registering = true;
        try {
            const api = extension.isActive ? extension.exports : await extension.activate();
            if (!api || typeof api.createJupyterServerCollection !== 'function') {
                this.log.warn('The Jupyter extension does not provide createJupyterServerCollection.');
                return;
            }
            const collection = api.createJupyterServerCollection(COLLECTION_ID, 'tOS Remote', {
                onDidChangeServers: this.serversEmitter.event,
                provideJupyterServers: () => this.jupyterServers(),
                resolveJupyterServer: (server) => this.jupyterServers().find((s) => s.id === server.id) || server
            });
            collection.commandProvider = {
                provideCommands: () => (this.running ? [] : [{ label: t('Start Jupyter on tOS'), canBeAutoSelected: true }]),
                handleCommand: async () => {
                    const server = (await this.start({ fromKernelPicker: true })) && this.jupyterServers()[0];
                    if (!server) {
                        throw new vscode.CancellationError();
                    }
                    return server;
                }
            };
            this.collection = collection;
            this.log.info('Registered the tOS Remote server collection with the Jupyter extension');
        } catch (error) {
            this.log.warn(`Could not register with the Jupyter extension: ${error.message}`);
        } finally {
            this.registering = false;
        }
    }

    jupyterServers() {
        if (!this.running) {
            return [];
        }
        const session = this.sessionMgr.readSession();
        return [{
            id: SERVER_ID,
            label: t('tOS Jupyter ({0})', session ? `${session.user}@${session.host}` : 'tOS'),
            connectionInformation: {
                baseUrl: vscode.Uri.parse(`http://127.0.0.1:${this.tunnel.localPort}`),
                token: this.state.token
            }
        }];
    }

    async showRunningMessage() {
        if (!vscode.extensions.getExtension(JUPYTER_EXTENSION_ID)) {
            return;
        }
        vscode.window.showInformationMessage(t('Jupyter is running on tOS. To run cells on the board, choose "tOS Remote" in Select Kernel.'));
    }

    // ---------------------------------------------------------------- 커널 자동 선택

    autoSelectEnabled() {
        return vscode.workspace.getConfiguration('tosRemote').get('jupyterAutoSelectKernel', true) !== false
            && this.sessionMgr.isOwnerWindow()
            && !!vscode.extensions.getExtension(JUPYTER_EXTENSION_ID);
    }

    /**
     * 노트북이나 #%% 셀 파일을 열면 보드 Jupyter 서버를 미리 시작한다.
     * Interactive 창은 만들 때 컨트롤러가 이미 있어야 마지막에 쓴 tOS 커널을 다시 고르기 때문이다.
     * 보드에 Jupyter가 없으면 아무것도 하지 않는다 (설치는 사용자가 필요할 때 패널에서).
     * @returns {Promise<boolean>} 서버가 실행 중이면 true
     */
    async prepareForCells() {
        if (!this.autoSelectEnabled()) {
            return false;
        }
        if (this.attaching) {
            await this.attaching;
        }
        if (this.running) {
            return true;
        }
        if (this.state.phase === 'reconnecting' || this.state.phase === 'stopping') {
            return false;
        }
        if (!this.starting && Date.now() - this.lastPrepareFailure < PREPARE_RETRY_MS) {
            return false;
        }
        try {
            const probe = await this.boardTools.ensureProbe();
            if (!scripts.toolStatus(probe).jupyter.ready) {
                return false;
            }
        } catch (error) {
            this.lastPrepareFailure = Date.now();
            this.log.debug(`Jupyter auto-start skipped: ${error.message}`);
            return false;
        }
        const started = await this.start({ interactive: false });
        if (!started) {
            this.lastPrepareFailure = Date.now();
        }
        return started;
    }

    /** 활성 노트북 편집기(노트북·Interactive 창)가 바뀌면 문서마다 한 번 tOS 커널을 고른다. */
    onActiveNotebookEditor(editor) {
        if (!editor || !KERNEL_NOTEBOOK_TYPES.has(editor.notebook.notebookType) || !this.autoSelectEnabled()) {
            return;
        }
        const key = editor.notebook.uri.toString();
        if (this.kernelHandled.has(key)) {
            return;
        }
        this.kernelHandled.add(key);
        this.autoSelectKernel(editor.notebook)
            .catch((error) => this.log.warn(`Jupyter kernel auto-selection failed: ${error.message}`));
    }

    isActiveNotebook(notebook) {
        const editor = vscode.window.activeNotebookEditor;
        return !!editor && editor.notebook === notebook;
    }

    async autoSelectKernel(notebook) {
        if (!(await this.prepareForCells())) {
            return;
        }
        await this.registerCollection();
        if (!this.collection || !this.isActiveNotebook(notebook)) {
            return;
        }
        const board = boardKey(this.sessionMgr.readSession());
        const state = this.sessionMgr.context.globalState;
        const ids = state.get(KERNEL_IDS_KEY) || {};
        const baseId = ids[board];
        if (baseId) {
            // notebook.selectKernel은 해당 컨트롤러가 아직 없으면 창을 띄우지 않고 false를 돌려준다
            const wanted = controllerIdFor(baseId, notebook.notebookType);
            for (let i = 0; i < SELECT_ATTEMPTS; i++) {
                if (!this.isActiveNotebook(notebook)) {
                    return;
                }
                if (await vscode.commands.executeCommand('notebook.selectKernel', { id: wanted, extension: JUPYTER_EXTENSION_ID })) {
                    this.log.info(`Selected the tOS Jupyter kernel for ${notebook.uri.toString(true)}`);
                    return;
                }
                await sleep(SELECT_INTERVAL_MS);
            }
            this.log.info('The remembered tOS Jupyter kernel is not available; asking for the kernel once.');
        }
        // 처음 한 번: Jupyter 확장의 tOS Remote 커널 목록(추천 커널 표시)에서 고르게 하고 그 커널을 기억한다
        const selected = await this.pickBoardKernel(notebook);
        if (!selected) {
            return;
        }
        await state.update(KERNEL_IDS_KEY, { ...ids, [board]: baseControllerId(selected) });
        if (this.isActiveNotebook(notebook)) {
            await vscode.commands.executeCommand('notebook.selectKernel', { id: selected, extension: JUPYTER_EXTENSION_ID });
        }
        this.log.info(`Remembered the tOS Jupyter kernel for ${board}`);
    }

    /**
     * Jupyter 확장의 "tOS Remote" 서버 선택 흐름을 실행한다 (서버가 하나뿐이라 커널 목록만 표시된다).
     * @returns {Promise<string|undefined>} 고른 컨트롤러 ID
     */
    async pickBoardKernel(notebook) {
        const extensionId = this.sessionMgr.context.extension.id;
        for (const id of [extensionId, extensionId.toLowerCase()]) {
            // 서버 모음 등록 직후에는 Jupyter 확장이 명령을 연결할 때까지 잠깐 걸린다
            for (let attempt = 0; attempt < 3; attempt++) {
                let selected;
                try {
                    selected = await vscode.commands.executeCommand('jupyter.kernel.selectJupyterServerKernel', id, COLLECTION_ID, notebook);
                } catch (error) {
                    // 사용자가 취소했거나 이 Jupyter 확장 버전에 명령이 없다
                    this.log.info(`tOS Jupyter kernel was not selected: ${error.message}`);
                    return undefined;
                }
                if (typeof selected === 'string' && selected) {
                    return selected;
                }
                await sleep(300);
            }
        }
        return undefined;
    }

    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.closeTunnel();
        if (this.collection) {
            this.collection.dispose();
            this.collection = undefined;
        }
        this.emitter.dispose();
        this.serversEmitter.dispose();
    }
}

module.exports = { JupyterManager, JUPYTER_EXTENSION_ID };
