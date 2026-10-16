'use strict';

// VS Code 확장 호스트 통합 테스트 (보드 대신 로컬 `rclone serve sftp` 사용)
// 실행: scripts/integration-test.ps1
// 환경 변수: TOS_IT_OUT(결과 파일), TOS_IT_SERVE_DIR(SFTP 루트), TOS_IT_PORT(SFTP 포트)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const vscode = require('vscode');
const { probeTcp, isProcessAlive, samePath } = require('../../src/util');
const { getSettings, targetOf } = require('../../src/settings');

const out = process.env.TOS_IT_OUT;
const log = (line) => fs.appendFileSync(out, `${line}\n`);

async function step(name, fn) {
    const start = Date.now();
    try {
        const result = await fn();
        log(`PASS ${name} (${Date.now() - start}ms)${result ? ` - ${result}` : ''}`);
        return result;
    } catch (error) {
        log(`FAIL ${name}: ${error.stack || error.message}`);
        throw error;
    }
}

async function run() {
    const serveDir = process.env.TOS_IT_SERVE_DIR;
    const port = Number(process.env.TOS_IT_PORT);
    let server;
    let api;
    let keepDaemon = false;

    // 보드 대신 사용할 SFTP 서버. 테스트가 서버 폴더에 직접 쓰는 파일이 바로 보이도록 디렉터리 캐시를 끈다.
    const startServer = async () => {
        server = spawn(api.prereq.rcloneExePath(), ['serve', 'sftp', serveDir, '--addr', `127.0.0.1:${port}`, '--user', 'tos', '--pass', 'secret',
            '--config', process.platform === 'win32' ? 'NUL' : os.devNull, '--dir-cache-time', '100ms'], { windowsHide: true });
        for (let i = 0; i < 50; i++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            const probe = await probeTcp('127.0.0.1', port, 1000);
            if (probe.ok && probe.banner) {
                return probe.banner;
            }
        }
        throw new Error('sftp server did not start');
    };

    try {
        await step('확장 활성화', async () => {
            const ext = vscode.extensions.getExtension('PlanXLab.tos-remote');
            assert.ok(ext, 'extension not found');
            api = await ext.activate();
            assert.ok(api && api.sessionMgr);
        });

        await step('기본 표시 언어(영어) 문자열', async () => checkEnglish(vscode.extensions.getExtension('PlanXLab.tos-remote')));

        await step('명령 등록', async () => {
            const all = await vscode.commands.getCommands(true);
            const expected = ['tosRemote.openWorkspace', 'tosRemote.closeWorkspace', 'tosRemote.testConnection', 'tosRemote.setupSshKey',
                'tosRemote.syncPythonLibraries', 'tosRemote.runFile', 'tosRemote.showMenu', 'tosRemote.panel.focus'];
            assert.deepStrictEqual(expected.filter((id) => !all.includes(id)), []);
        });

        await step('사이드바 패널 표시', async () => {
            await vscode.commands.executeCommand('tosRemote.panel.focus');
        });

        await step('사전 점검 (ssh)', async () => {
            const state = await api.prereq.refresh();
            assert.ok(state.ssh, 'OpenSSH client not found');
            return `ssh=${state.ssh}`;
        });

        await step('패키지 관리자 작업 실행·종료 코드 수신 (설치 없이 SSH 버전으로 검증)', async () => {
            const code = await api.prereq.runPackageManager({
                label: 'OpenSSH test',
                command: api.ssh.sshPath,
                args: ['-V']
            });
            assert.strictEqual(code, 0);
        });

        await step('rclone 내려받기·검증·설치', async () => {
            const result = await api.prereq.installRclone({ usePackageManager: false });
            assert.ok(result && fs.existsSync(result.exePath), 'rclone not installed');
            fs.writeFileSync(path.join(path.dirname(serveDir), 'rclone-path.txt'), result.exePath, 'utf8');
            const state = await api.prereq.refresh();
            assert.strictEqual(state.rcloneVersion, result.version);
            return `v${result.version} → ${result.exePath}`;
        });

        await step('테스트 SFTP 서버 시작', async () => startServer());

        const testLocalDir = path.join(path.dirname(serveDir), 'local-workspace');
        const config = vscode.workspace.getConfiguration('tosRemote');
        await config.update('host', '127.0.0.1', vscode.ConfigurationTarget.Global);
        await config.update('port', port, vscode.ConfigurationTarget.Global);
        await config.update('user', 'tos', vscode.ConfigurationTarget.Global);

        await step('작업 공간 설정: 이전 절대 경로 변환·홈 밖 경로 거부·패널 입력', async () => {
            const { migrateSettings, updateSetting, validateSettings } = require('../../src/settings');
            await config.update('remoteWorkspace', '/home/tos/Workspace', vscode.ConfigurationTarget.Global);
            await migrateSettings();
            assert.strictEqual(vscode.workspace.getConfiguration('tosRemote').get('remoteWorkspace'), 'Workspace');
            await assert.rejects(updateSetting('remoteWorkspace', '/etc/work'));
            await updateSetting('remoteWorkspace', '/home/tos/class/vision');
            assert.strictEqual(vscode.workspace.getConfiguration('tosRemote').get('remoteWorkspace'), 'class/vision');
            await config.update('remoteWorkspace', '../x', vscode.ConfigurationTarget.Global);
            assert.ok(validateSettings(getSettings()), 'invalid workspace must not validate');
            await updateSetting('remoteWorkspace', 'Workspace');
            await updateSetting('localWorkspace', testLocalDir);
            const s = getSettings();
            assert.deepStrictEqual([s.workspaceFolder, s.remoteWorkspace, s.localWorkspace], ['Workspace', '/home/tos/Workspace', testLocalDir]);
            return `${s.workspaceFolder} → ${s.remoteWorkspace} (local: ${s.localWorkspace})`;
        });
        const target = targetOf(getSettings());

        await step('비밀번호 인증 확인 (틀린/맞는 비밀번호)', async () => {
            const wrong = await api.auth.testPassword(target, 'wrong');
            assert.strictEqual(wrong.ok, false);
            const right = await api.auth.testPassword(target, 'secret');
            assert.strictEqual(right.ok, true, right.error);
            await api.auth.storePassword(target, 'secret');
        });

        const session = await step('연결 (데몬·없는 작업 공간 생성·로컬 동기화·작업 공간 파일)', async () => {
            assert.ok(!fs.existsSync(path.join(serveDir, 'home')), 'serve dir must start empty');
            const s = await api.sessionMgr.connect(getSettings(), undefined, { report() {} }, { interactive: false });
            assert.strictEqual(s.authType, 'password');
            assert.strictEqual(s.remoteWorkspace, '/home/tos/Workspace');
            assert.ok(fs.existsSync(path.join(serveDir, 'home', 'tos', 'Workspace')), 'remote workspace not created');
            assert.ok(fs.existsSync(s.localWorkspace), 'local workspace folder not created');
            const ws = JSON.parse(fs.readFileSync(api.sessionMgr.workspaceFile, 'utf8'));
            assert.strictEqual(ws.folders[0].path, s.localWorkspace.replace(/\\/g, '/'));
            return `local=${s.localWorkspace}`;
        }).then(() => api.sessionMgr.readSession());

        await step('로컬에 쓰기 → 업로드 완료 대기 → SFTP 쪽 반영 (10회 반복)', async () => {
            const localVision = path.join(session.localWorkspace, 'vision');
            fs.mkdirSync(localVision, { recursive: true });
            const remote = path.join(serveDir, 'home', 'tos', 'Workspace', 'vision', 'infer.py');
            const times = [];
            for (let i = 0; i < 10; i++) {
                const content = `print("hello ${i}")\n`;
                fs.writeFileSync(path.join(localVision, 'infer.py'), content);
                const start = Date.now();
                const flushed = await api.sessionMgr.waitForUploads(20000);
                times.push(Date.now() - start);
                assert.ok(flushed, 'uploads not flushed');
                assert.strictEqual(fs.readFileSync(remote, 'utf8'), content, `iteration ${i}`);
            }
            fs.writeFileSync(path.join(localVision, 'infer.py'), 'print("hello")\n');
            assert.ok(await api.sessionMgr.waitForUploads(20000));
            return `wait ms: ${times.join(', ')}`;
        });

        await step('SFTP 쪽 변경 → 보드에서 가져오기 후 표시', async () => {
            fs.writeFileSync(path.join(serveDir, 'home', 'tos', 'Workspace', 'from_board.txt'), 'x');
            await api.sessionMgr.refreshDrive();
            assert.ok(fs.existsSync(path.join(session.localWorkspace, 'from_board.txt')));
        });

        await step('경로 매핑 (터미널 링크·디버그)', async () => {
            const mappings = api.sessionMgr.getPathMappings();
            assert.deepStrictEqual(mappings[0], { remote: '/home/tos/Workspace', local: path.normalize(session.localWorkspace) });
        });

        await step('같은 설정으로 다시 연결 시 기존 로컬 작업 공간 재사용', async () => {
            const s = await api.sessionMgr.connect(getSettings(), api.sessionMgr.readSession(), { report() {} }, { interactive: false, quick: true });
            assert.strictEqual(s.localWorkspace, session.localWorkspace);
        });

        await step('라이브러리 동기화: 필수 실패만 알림, 선택(없음·가상 환경)은 알림 없음', async () => {
            const venvPkg = path.join(serveDir, 'home', 'tos', 'Workspace', '.venv', 'lib', 'python3.12', 'site-packages', 'mypkg');
            fs.mkdirSync(venvPkg, { recursive: true });
            fs.writeFileSync(path.join(venvPkg, '__init__.py'), 'VALUE = 1\n');
            fs.writeFileSync(path.join(venvPkg, 'data.bin'), 'x');
            const venv = { remote: '/home/tos/Workspace/.venv/lib/python3.12/site-packages', kind: 'venv' };
            const missingUser = { remote: '/home/tos/.local/lib/python3.12/site-packages', kind: 'user' };
            const missingSystem = { remote: '/var/lib/tos/none/site-packages', kind: 'system' };

            const warnings = [];
            const original = vscode.window.showWarningMessage;
            vscode.window.showWarningMessage = (...args) => {
                warnings.push(args[0]);
                return Promise.resolve(undefined);
            };
            try {
                await api.sessionMgr.syncLibraries([venv, missingUser], false);
                assert.deepStrictEqual(warnings, [], `optional paths must not warn: ${warnings}`);
                const cache = require('../../src/pyLibs').localCachePath(venv.remote);
                assert.ok(fs.existsSync(path.join(cache, 'mypkg', '__init__.py')), 'venv not synced');
                assert.ok(!fs.existsSync(path.join(cache, 'mypkg', 'data.bin')), 'non-python file synced');

                await api.sessionMgr.syncLibraries([missingSystem], false);
                assert.strictEqual(warnings.length, 1, 'required path failure must warn');
                fs.rmSync(cache, { recursive: true, force: true });
            } finally {
                vscode.window.showWarningMessage = original;
            }
            return `warning: ${warnings[0]}`;
        });

        await step('상태 계산 (작업 공간 창 없음 → detached)', async () => {
            const status = await api.sessionMgr.refreshStatus();
            assert.strictEqual(status.phase, 'detached');
            assert.strictEqual(status.mounted, true);
        });

        await step('보드(SFTP) 중단 중에도 상태 조회가 멈추지 않음', async () => {
            server.kill();
            await new Promise((resolve) => setTimeout(resolve, 500));
            const start = Date.now();
            const status = await api.sessionMgr.refreshStatus();
            const elapsed = Date.now() - start;
            assert.ok(elapsed < 3000, `refreshStatus took ${elapsed}ms`);
            await startServer();
            return `${elapsed}ms, phase=${status.phase}`;
        });

        await step('rclone 데몬 강제 종료 → 자동 복구', async () => {
            const oldPid = api.rclone.readState().pid;
            process.kill(oldPid);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            assert.strictEqual(await api.rclone.isDaemonAlive(), false);
            await api.sessionMgr.recover(api.sessionMgr.readSession(), false);
            const state = api.rclone.readState();
            assert.notStrictEqual(state.pid, oldPid);
            assert.strictEqual(fs.readFileSync(path.join(session.localWorkspace, 'vision', 'infer.py'), 'utf8'), 'print("hello")\n');
            return `pid ${oldPid} → ${state.pid}`;
        });

        await step('닫기 (업로드 확인·데몬 종료)', async () => {
            const pid = api.rclone.readState().pid;
            await api.sessionMgr.finishClose();
            assert.strictEqual(api.rclone.readState(), undefined);
            assert.strictEqual(api.sessionMgr.readSession(), undefined);
            assert.ok(!isProcessAlive(pid), 'daemon still alive');
        });

        await step('다시 연결해 둔 채 종료 (2단계: 확장 호스트 종료 후 유지·작업 공간 창 재연결 확인용)', async () => {
            const s = await api.sessionMgr.connect(getSettings(), undefined, { report() {} }, { interactive: false });
            const state = api.rclone.readState();
            fs.writeFileSync(path.join(path.dirname(out), 'daemon-pid.txt'), String(state.pid));
            fs.writeFileSync(path.join(path.dirname(out), 'workspace-file.txt'), api.sessionMgr.workspaceFile);
            keepDaemon = true;
            return `pid=${state.pid}, local=${s.localWorkspace}`;
        });
    } finally {
        if (server) {
            server.kill();
        }
        if (api && !keepDaemon) {
            await api.rclone.quitDaemon().catch(() => {});
        }
    }
}

const PHASES = { 1: run, 2: runPhase2, ko: runPhaseKo };
module.exports = { run: PHASES[process.env.TOS_IT_PHASE || '1'] || run };

// 한국어 표시 언어(--locale=ko, 한국어 언어 팩 설치)에서 번역 확인
async function runPhaseKo() {
    const ext = vscode.extensions.getExtension('PlanXLab.tos-remote');
    await step('[ko] 표시 언어가 한국어', async () => {
        await ext.activate();
        assert.ok(vscode.env.language.startsWith('ko'), `language=${vscode.env.language}`);
        return vscode.env.language;
    });
    await step('[ko] 매니페스트(package.nls.ko.json) 번역', async () => {
        const commands = ext.packageJSON.contributes.commands;
        // 번역된 명령 제목은 { value, original } 형태로 제공된다
        const title = (id) => {
            const value = commands.find((c) => c.command === id).title;
            return typeof value === 'string' ? value : value.value;
        };
        assert.strictEqual(title('tosRemote.runFile'), 'tOS에서 실행');
        assert.strictEqual(title('tosRemote.debugFile'), 'tOS에서 디버그');
        assert.strictEqual(ext.packageJSON.contributes.walkthroughs[0].steps[0].media.markdown, 'media/walkthrough/ko/rclone.md');
        return `${title('tosRemote.runFile')} / ${title('tosRemote.debugFile')}`;
    });
    await step('[ko] 런타임 문자열(l10n bundle) 번역', async () => {
        const { t } = require('../../src/i18n');
        assert.strictEqual(t('Run on tOS: {0}', 'a.py'), 'tOS에서 실행: a.py');
        const { webviewStrings } = require('../../src/panel');
        assert.strictEqual(webviewStrings().openWorkspace, '▶ 원격 작업 공간 열기');
        const { buildSshTerminalScript } = require('../../src/sshTerminal');
        assert.ok(buildSshTerminalScript('C:\\ssh.exe', ['-p', '22'], 'win32').includes('보드 연결 실패'));
        return t('Run on tOS: {0}', 'a.py');
    });
    await step('[ko] 사이드바 패널 표시', async () => {
        await vscode.commands.executeCommand('tosRemote.panel.focus');
    });
}

async function checkEnglish(ext) {
    const commands = ext.packageJSON.contributes.commands;
    const raw = commands.find((c) => c.command === 'tosRemote.runFile').title;
    const title = typeof raw === 'string' ? raw : raw.value;
    assert.strictEqual(title, 'Run on tOS');
    const { t } = require('../../src/i18n');
    assert.strictEqual(t('Run on tOS: {0}', 'a.py'), 'Run on tOS: a.py');
    return `language=${vscode.env.language}, ${title}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 2단계: 생성된 작업 공간 파일로 연 창 (= "원격 작업 공간 열기" 후 창 재로드 상황)
async function runPhase2() {
    let api;
    try {
        await step('[2단계] 작업 공간 창에서 확장 활성화·재연결(attach)', async () => {
            const ext = vscode.extensions.getExtension('PlanXLab.tos-remote');
            api = await ext.activate();
            for (let i = 0; i < 100 && (!api.sessionMgr.status || api.sessionMgr.status.phase !== 'open'); i++) {
                await sleep(200);
            }
            assert.strictEqual(api.sessionMgr.status.phase, 'open');
            assert.ok(api.sessionMgr.isOwnerWindow(), 'not owner window');
            const owner = JSON.parse(fs.readFileSync(api.sessionMgr.ownerFile, 'utf8'));
            assert.strictEqual(owner.pid, process.pid);
        });

        const session = api.sessionMgr.readSession();
        const folder = vscode.workspace.workspaceFolders[0];

        await step('[2단계] 작업 공간 설정 (폴더·터미널·launch·Pylance)', async () => {
            assert.ok(samePath(folder.uri.fsPath, session.localWorkspace));
            const terminal = vscode.workspace.getConfiguration('terminal.integrated');
            const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
            const profileName = terminal.get(`defaultProfile.${platform}`);
            assert.strictEqual(profileName, 'tOS SSH');
            const profile = terminal.get(`profiles.${platform}`)[profileName];
            const scriptPath = process.platform === 'win32' ? profile.args[2] : profile.args[0];
            assert.ok(process.platform === 'win32' ? /cmd\.exe$/i.test(profile.path) : profile.path === '/bin/sh', profile.path);
            assert.ok(fs.existsSync(scriptPath), 'SSH terminal script missing');
            assert.ok(fs.readFileSync(scriptPath, 'utf8').includes(process.platform === 'win32'
                ? 'if not errorlevel 255 exit /b 0' : 'if [ "$status" -ne 255 ]; then'));
            const launch = vscode.workspace.getConfiguration('launch', folder.uri).get('configurations');
            assert.strictEqual(launch[0].type, 'tos-remote');
            assert.strictEqual(vscode.workspace.getConfiguration('files').get('eol'), '\n');
            assert.ok(vscode.workspace.getConfiguration('python.analysis').get('extraPaths').length > 0);
            return `folder=${folder.uri.fsPath}`;
        });

        const inferFile = path.join(session.localWorkspace, 'vision', 'infer.py');

        await step('[2단계] 실행 대상 경로 변환', async () => {
            const target = api.runner.resolveTarget(vscode.Uri.file(inferFile));
            assert.strictEqual(target.relativePath, 'vision/infer.py');
            assert.throws(() => api.runner.resolveTarget(vscode.Uri.file(path.join(os.tmpdir(), 'outside-workspace.py'))));
        });

        await step('[2단계] 기본 터미널(SSH) 생성 후 즉시 종료되지 않음', async () => {
            const terminal = vscode.window.createTerminal({ name: 'tOS SSH' });
            await sleep(4000);
            assert.strictEqual(terminal.exitStatus, undefined, `terminal exited: ${JSON.stringify(terminal.exitStatus)}`);
            terminal.dispose();
        });

        await step('[2단계] 터미널 경로 링크 → 로컬 파일 해당 줄 열기', async () => {
            const { TerminalLinkProvider } = require('../../src/terminalLinks');
            const provider = new TerminalLinkProvider(api.sessionMgr);
            const links = provider.provideTerminalLinks({ line: '  File "/home/tos/Workspace/vision/infer.py", line 1, in <module>' });
            assert.strictEqual(links.length, 1);
            await provider.handleTerminalLink(links[0]);
            const editor = vscode.window.activeTextEditor;
            assert.ok(editor, 'no editor opened');
            assert.ok(samePath(editor.document.uri.fsPath, inferFile));
            assert.strictEqual(editor.selection.active.line, 0);
        });

        const waitRunTask = async () => {
            let execution;
            for (let i = 0; i < 50 && !execution; i++) {
                execution = vscode.tasks.taskExecutions.find((e) => e.task.source === 'tOS');
                await sleep(200);
            }
            assert.ok(execution, 'run task not started');
            const name = execution.task.name;
            execution.terminate();
            for (let i = 0; i < 25 && vscode.tasks.taskExecutions.some((e) => e.task.source === 'tOS'); i++) {
                await sleep(200);
            }
            return name;
        };

        await step('[2단계] Ctrl+F5 (workbench.action.debug.run) → 보드 실행 작업', async () => {
            const uri = vscode.Uri.file(inferFile);
            await vscode.window.showTextDocument(uri);
            await vscode.commands.executeCommand('workbench.action.debug.run');
            const name = await waitRunTask();
            assert.strictEqual(name, 'Run on tOS: vision/infer.py');
            assert.strictEqual(vscode.debug.activeDebugSession, undefined, 'debug session must not start');
            return name;
        });

        await step('[2단계] 실행 작업은 플랫폼별 스크립트로 명령줄을 숨긴다', async () => {
            const { terminalScriptPath } = require('../../src/sshTerminal');
            const script = terminalScriptPath(api.sessionMgr.storageDir, 'run-on-tos');
            const content = fs.readFileSync(script, 'utf8');
            if (process.platform === 'win32') {
                assert.ok(content.includes('!TOS_SSH_EXE! !TOS_SSH_ARGS!'), 'run script must take ssh from environment variables');
                assert.ok(!/ssh\.exe/i.test(content), 'run script must not contain the ssh command line');
            } else {
                assert.ok(content.startsWith('#!/bin/sh\n'));
                assert.ok(content.includes('status=$?'));
                assert.ok(!content.includes('set -x'), 'the SSH command must not be echoed');
            }
        });

        await step('[2단계] Run 버튼 메뉴 "Run on tOS" (tosRemote.runFile)', async () => {
            await vscode.commands.executeCommand('tosRemote.runFile', vscode.Uri.file(inferFile));
            assert.strictEqual(await waitRunTask(), 'Run on tOS: vision/infer.py');
        });

        await step('[2단계] Run 버튼 메뉴 "Debug on tOS" → Python Debugger 확장이 없으면 시작하지 않음', async () => {
            const started = await vscode.commands.executeCommand('tosRemote.debugFile', vscode.Uri.file(inferFile));
            assert.strictEqual(started, false);
            assert.strictEqual(vscode.debug.activeDebugSession, undefined);
        });

        await step('[2단계] F5(디버그) → Python Debugger 확장이 없으면 시작하지 않음', async () => {
            const started = await vscode.debug.startDebugging(folder, { type: 'tos-remote', request: 'launch', name: 'it', program: inferFile });
            assert.strictEqual(started, false);
            assert.strictEqual(vscode.debug.activeDebugSession, undefined);
        });

        await step('[2단계] 보드 도구·Jupyter 명령 등록과 초기 상태', async () => {
            const all = await vscode.commands.getCommands(true);
            const expected = ['tosRemote.checkBoardTools', 'tosRemote.installDebugTools', 'tosRemote.installJupyter', 'tosRemote.startJupyter',
                'tosRemote.stopJupyter', 'tosRemote.showJupyterLog', 'tosRemote.installUv'];
            assert.deepStrictEqual(expected.filter((id) => !all.includes(id)), []);
            assert.strictEqual(api.boardTools.status().available, true);
            assert.strictEqual(api.jupyter.status().phase, 'stopped');
        });

        await step('[2단계] 닫기 마무리 (데몬 종료)', async () => {
            await vscode.commands.executeCommand('workbench.action.closeAllEditors');
            await api.sessionMgr.finishClose();
            assert.strictEqual(api.rclone.readState(), undefined);
        });
    } finally {
        if (api && api.rclone.readState()) {
            await api.rclone.quitDaemon().catch(() => {});
        }
    }
}
