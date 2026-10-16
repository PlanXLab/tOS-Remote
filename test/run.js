'use strict';

// 의존성 없는 단위 테스트: `node test/run.js` (VS Code API가 필요 없는 모듈만 대상)
const assert = require('assert');
const path = require('path');

const { createMatcher, findLinks } = require('../src/linkParser');
const { obscure, reveal } = require('../src/obscure');
const util = require('../src/util');
const { sftpConnectionString, sftpEnv, compareVersions } = require('../src/rclone');
const { buildWorkspace, sshTerminalArgs } = require('../src/workspaceFile');
const { buildSshTerminalScript, buildRunScript, runScriptEnv, quoteWindowsArg, echoLine } = require('../src/sshTerminal');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { buildDebugScript } = require('../src/debugScript');
const { localCachePath, parseDetectedPaths, isRequired, sessionLibraries } = require('../src/pyLibs');
const board = require('../src/boardScripts');
const { compileArgs, parsePylock, uvEnv } = require('../src/packageResolver');
const { AskpassBroker, buildAskpassCmd } = require('../src/askpass');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('linkParser: Python traceback / gcc / pdb / 경계', () => {
    const m = createMatcher([
        { remote: '/home/tos/Workspace/', local: 'Z:\\' },
        { remote: '/var/lib/tos/uv/python/cpython-3.12-linux-aarch64-gnu/lib/python3.12/site-packages', local: 'C:/cache/sp' }
    ]);
    const t = (line) => findLinks(m, line);
    const span = (line, l) => line.slice(l.startIndex, l.startIndex + l.length);

    let s = '  File "/home/tos/Workspace/sub dir/a.py", line 12, in <module>';
    let r = t(s);
    assert.deepStrictEqual([r[0].relative, r[0].line], ['sub dir/a.py', 12]);
    assert.strictEqual(span(s, r[0]), '/home/tos/Workspace/sub dir/a.py", line 12');

    s = '/home/tos/Workspace/a.c:3:5: error: x';
    r = t(s);
    assert.deepStrictEqual([r[0].relative, r[0].line, r[0].column, span(s, r[0])], ['a.c', 3, 5, '/home/tos/Workspace/a.c:3:5']);

    r = t('> /home/tos/Workspace/a.py(9)<module>()');
    assert.deepStrictEqual([r[0].relative, r[0].line], ['a.py', 9]);

    r = t('saved to /home/tos/Workspace/out.png.');
    assert.deepStrictEqual([r[0].relative, r[0].line], ['out.png', undefined]);

    assert.strictEqual(t('/home/tos/Workspace2/a.py:1').length, 0);
    assert.strictEqual(t('/x/home/tos/Workspace/a.py:1').length, 0);

    r = t('  File "/var/lib/tos/uv/python/cpython-3.12-linux-aarch64-gnu/lib/python3.12/site-packages/torch/nn/modules/module.py", line 1736, in f');
    assert.deepStrictEqual([r[0].relative, r[0].line, r[0].local], ['torch/nn/modules/module.py', 1736, 'C:/cache/sp']);
    assert.strictEqual(createMatcher([]), null);
});

test('obscure: rclone reveal 호환', () => {
    // `rclone obscure tos` 출력값 (rclone v1.75.1)
    assert.strictEqual(reveal('rYqP1VxF_OE4mv7Lrs-DiZSz4Q'), 'tos');
    for (const value of ['', 'p@ss word!', '한글 비밀번호', "it's"]) {
        assert.strictEqual(reveal(obscure(value)), value);
    }
});

test('util: shellQuote / 경로 정규화', () => {
    assert.strictEqual(util.shellQuote("a'b c"), "'a'\\''b c'");
    assert.strictEqual(util.normalizeRemotePath(' /home//tos/Workspace/ '), '/home/tos/Workspace');
    assert.strictEqual(util.normalizeRemotePath(''), '/');
    assert.strictEqual(util.normalizeDriveLetter('z'), 'Z:');
    assert.strictEqual(util.normalizeDriveLetter('Y:\\'), 'Y:');
    assert.strictEqual(util.normalizeDriveLetter('C:'), '');
    assert.strictEqual(util.normalizeDriveLetter('ZZ'), '');
});

test('util: 작업 공간 경로(홈 기준 상대 경로) 정규화', () => {
    const n = (value, user = 'tos') => util.normalizeWorkspaceFolder(value, user);
    assert.deepStrictEqual(n('Workspace'), { folder: 'Workspace' });
    assert.deepStrictEqual(n(' class//vision/ '), { folder: 'class/vision' });
    assert.deepStrictEqual(n('class\\vision'), { folder: 'class/vision' });
    assert.deepStrictEqual(n('~/Workspace'), { folder: 'Workspace' });
    assert.deepStrictEqual(n('/home/tos/Workspace'), { folder: 'Workspace' }, 'legacy absolute path');
    assert.deepStrictEqual(n('/home/tos/a/b/'), { folder: 'a/b' });
    assert.strictEqual(n('/home/other/Workspace').error, 'outside');
    assert.strictEqual(n('/var/lib/x').error, 'outside');
    assert.strictEqual(n('/home/tos').error, 'empty');
    assert.strictEqual(n('').error, 'empty');
    assert.strictEqual(n('~').error, 'empty');
    assert.strictEqual(n('a/../b').error, 'invalid');
    assert.strictEqual(n('./a').error, 'invalid');
    assert.deepStrictEqual(n('/root/work', 'root'), { folder: 'work' });
    assert.strictEqual(util.homeDirOf('tos'), '/home/tos');
    assert.strictEqual(util.homeDirOf('root'), '/root');
    assert.strictEqual(util.workspacePathOf('pi', 'class/vision'), '/home/pi/class/vision');
});

test('rclone: 접속 문자열과 환경 변수', () => {
    const target = { host: '192.168.254.1', port: 22, user: "o'neil" };
    const keyed = sftpConnectionString(target, { type: 'key', keyPath: 'C:\\Users\\a b\\.ssh\\id_ed25519' }, '/home/tos/Workspace');
    assert.strictEqual(keyed, ":sftp,host='192.168.254.1',port=22,user='o''neil',shell_type=unix,disable_hashcheck=true,known_hosts_file=none,key_file='C:/Users/a b/.ssh/id_ed25519':/home/tos/Workspace");
    const env = sftpEnv(target, { type: 'password', obscured: 'XYZ' });
    assert.strictEqual(env.RCLONE_SFTP_PASS, 'XYZ');
    assert.strictEqual(env.RCLONE_SFTP_KEY_FILE, undefined);
    assert.ok(compareVersions('1.75.1', '1.65.0') > 0);
    assert.ok(compareVersions('1.64.9', '1.65.0') < 0);
});

test('workspaceFile: 설정·터미널·launch', () => {
    const ws = buildWorkspace({
        drive: 'Y:',
        target: { host: '10.0.0.2', port: 2222, user: 'tos' },
        remoteWorkspace: "/home/tos/My Work",
        sshPath: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
        sshArgs: ['-p', '2222'],
        libraryCachePaths: ['C:\\cache\\a']
    });
    assert.strictEqual(ws.folders[0].path, 'Y:/');
    assert.deepStrictEqual(ws.settings['python.analysis.extraPaths'], ['C:/cache/a']);
    const profile = ws.settings['terminal.integrated.profiles.windows'][ws.settings['terminal.integrated.defaultProfile.windows']];
    assert.deepStrictEqual(profile.args.slice(-3), ['-t', 'tos@10.0.0.2', `cd '/home/tos/My Work'; exec $SHELL -l`]);
    assert.strictEqual(ws.launch.configurations[0].type, 'tos-remote');
    assert.strictEqual(ws.launch.configurations[0].name, 'tOS: Current File');
    JSON.parse(JSON.stringify(ws));
});

test('debugScript: 포트·경로 인용', () => {
    const script = buildDebugScript({ remoteWorkspace: '/home/tos/Workspace', pythonCommand: 'python3', relativePath: "vision/it's.py", port: 5678 });
    assert.ok(script.includes(':162E '));
    assert.ok(script.includes(`--wait-for-client 'vision/it'\\''s.py' &`));
    assert.ok(script.endsWith('wait $P\n'));
    assert.ok(!script.includes('\r'));
});

test('pyLibs: 캐시 경로', () => {
    const local = localCachePath('/var/lib/tos/uv/python/site-packages');
    assert.ok(local.endsWith(path.join('python-libs', 'var_lib_tos_uv_python_site-packages')));
});

test('pyLibs: 감지 결과의 종류·심볼릭 링크 중복 제거·별칭', () => {
    const real = '/var/lib/tos/uv/python/cpython-3.12.14-linux-aarch64-gnu/lib/python3.12/site-packages';
    const link = '/var/lib/tos/uv/python/cpython-3.12-linux-aarch64-gnu/lib/python3.12/site-packages';
    const venv = '/home/tos/Workspace/.venv/lib/python3.12/site-packages';
    const result = parseDetectedPaths(`system\t${real}\t${real}\nsystem\t${real}\t${link}\nvenv\t${venv}\t${venv}\n\nWarning: x\nbogus\t/x\t/x\n`);
    assert.deepStrictEqual(result.libraries, [{ remote: real, kind: 'system' }, { remote: venv, kind: 'venv' }]);
    assert.deepStrictEqual(result.aliases, [{ remote: link, real }]);
    assert.strictEqual(isRequired({ kind: 'system' }), true);
    assert.strictEqual(isRequired({ kind: 'custom' }), true);
    assert.strictEqual(isRequired({ kind: 'user' }), false);
    assert.strictEqual(isRequired({ kind: 'venv' }), false);
    assert.deepStrictEqual(sessionLibraries({ libraryPaths: [real, '/home/tos/.local/lib/python3.12/site-packages'] }).map((l) => l.kind), ['system', 'user']);
});

test('sshTerminal: cmd 배치 파일 (인용·% 이스케이프·재시도)', () => {
    const ws = buildWorkspace({
        drive: 'Z:',
        target: { host: 'h', port: 22, user: 'tos' },
        remoteWorkspace: '/home/tos/Workspace',
        sshPath: 'C:\\ssh.exe',
        sshArgs: ['-p', '22'],
        terminal: { path: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/c', 'C:\\s\\ssh-terminal.cmd'] },
        libraryCachePaths: []
    });
    const profile = ws.settings['terminal.integrated.profiles.windows']['tOS SSH'];
    assert.deepStrictEqual([profile.path, profile.args], ['C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'C:\\s\\ssh-terminal.cmd']]);

    assert.strictEqual(quoteWindowsArg('plain'), 'plain');
    assert.strictEqual(quoteWindowsArg('a b'), '"a b"');
    assert.strictEqual(quoteWindowsArg('K="C:/a b/k"'), '"K=\\"C:/a b/k\\""');
    assert.strictEqual(quoteWindowsArg('C:\\x y\\'), '"C:\\x y\\\\"');

    const args = sshTerminalArgs(['-p', '22', '-o', 'UserKnownHostsFile="C:/Users/a b/known_hosts"', '-i', 'C:\\Users\\a b\\.ssh\\id'],
        { host: 'h', user: 'tos' }, '/home/tos/50%');
    const script = buildSshTerminalScript('C:\\Windows\\System32\\OpenSSH\\ssh.exe', args);
    const line = script.split('\r\n').find((l) => l.includes('ssh.exe'));
    assert.strictEqual(line, 'C:\\Windows\\System32\\OpenSSH\\ssh.exe -p 22 -o "UserKnownHostsFile=\\"C:/Users/a b/known_hosts\\"" '
        + '-i "C:\\Users\\a b\\.ssh\\id" -t tos@h "cd \'/home/tos/50%%\'; exec $SHELL -l"');
    assert.ok(script.includes('if not errorlevel 255 exit /b 0'));
    assert.throws(() => buildSshTerminalScript('ssh.exe', ['a&b']));
});

test('sshTerminal: tOS에서 실행 배치 파일 (명령줄 숨김·지연 확장·종료 코드 0)', () => {
    const script = buildRunScript();
    const lines = script.split('\r\n');
    assert.ok(lines.includes('setlocal EnableDelayedExpansion'));
    assert.ok(lines.includes('!TOS_SSH_EXE! !TOS_SSH_ARGS!'), 'ssh must come from environment variables');
    assert.ok(lines.includes('if not "%TOS_EXIT%"=="255" exit /b 0'));
    assert.strictEqual(lines.filter((l) => l.startsWith('exit /b')).every((l) => l === 'exit /b 0'), true, 'must always exit 0');
    assert.ok(!/ssh\.exe|tos@/i.test(script), 'no user data in the batch file');
    assert.ok(!script.replace(/\r\n/g, '').includes('\n'));
    const env = runScriptEnv('C:\\Program Files\\x!y%\\ssh.exe', ['-p', '22', '-t', 'tos@h', "cd '/home/tos/My Work' && python3 -u 'a & b.py'"]);
    assert.strictEqual(env.TOS_SSH_EXE, '"C:\\Program Files\\x!y%\\ssh.exe"');
    assert.strictEqual(env.TOS_SSH_ARGS, `-p 22 -t tos@h "cd '/home/tos/My Work' && python3 -u 'a & b.py'"`);
});

test('debugScript: debugpy가 없으면 설치 안내용 표시', () => {
    const script = buildDebugScript({ remoteWorkspace: '/home/tos/Workspace', pythonCommand: 'python3', relativePath: 'a.py', port: 5678 });
    assert.ok(script.includes(`python3 -c 'import debugpy' 2>/dev/null || { echo TOS_DEBUGPY_MISSING; exit 1; }`));
    assert.ok(script.indexOf('TOS_DEBUGPY_MISSING') < script.indexOf('-m debugpy'));
});

// tOS-Lite 1.0 보드에서 확인한 값
const TOS_PROBE = {
    python: '/usr/local/bin/python3',
    version: '3.12.14',
    implementation: 'CPython',
    machine: 'aarch64',
    libc: 'glibc',
    libcVersion: '2.41',
    externallyManaged: true,
    pip: '26.2.1',
    pipWrapper: true,
    packages: { debugpy: '1.8.22', jupyter_server: null, ipykernel: null },
    runDebug: true,
    runDebugExecutable: true,
    distributions: { debugpy: '1.8.22', psutil: '7.2.2', packaging: '26.3', pip: '26.2.1', 'bad name': '1', ok: '1.0 ; rm' }
};

test('boardScripts: run_debug.sh는 tOS-Lite 1.0과 같은 내용', () => {
    assert.strictEqual(board.RUN_DEBUG_PATH, '/usr/local/bin/run_debug.sh');
    assert.strictEqual(Buffer.byteLength(board.RUN_DEBUG_SCRIPT), 182);
    assert.ok(board.RUN_DEBUG_SCRIPT.startsWith('#!/bin/sh\npkill -f debugpy\necho "DEBUG_START"\n'));
    assert.ok(!board.RUN_DEBUG_SCRIPT.includes('\r'));
});

test('boardScripts: 도구 확인 명령·출력 해석·상태', () => {
    const command = board.buildProbeCommand('python3');
    assert.ok(command.startsWith("python3 -c 'import json, os, platform"));
    assert.ok(!board.TOOLS_PROBE_PY.includes('sudo'), 'probe must not run sudo');
    const probe = board.parseProbeOutput(`noise\nTOS_TOOLS\t${JSON.stringify(TOS_PROBE)}\n`);
    assert.strictEqual(probe.python, '/usr/local/bin/python3');
    assert.deepStrictEqual(probe.packages, { debugpy: '1.8.22', jupyter_server: null, ipykernel: null });
    assert.deepStrictEqual(board.parseProbeOutput('TOS_TOOLS_ERROR\tboom'), { error: 'boom' });
    assert.strictEqual(board.parseProbeOutput('nothing'), undefined);
    const status = board.toolStatus(probe);
    assert.deepStrictEqual(status.debug, { ready: true, debugpy: '1.8.22', runDebug: true });
    assert.deepStrictEqual(status.jupyter, { ready: false, jupyterServer: null, ipykernel: null });
    assert.strictEqual(board.toolStatus({ ...probe, runDebugExecutable: false }).debug.ready, false);
});

test('boardScripts: uv 해석 대상 (Python 3.x, manylinux)', () => {
    assert.deepStrictEqual(board.resolveTarget(TOS_PROBE), { pythonVersion: '3.12.14', platform: 'aarch64-manylinux_2_40' });
    assert.deepStrictEqual(board.resolveTarget({ ...TOS_PROBE, version: '3.9.2', libcVersion: '2.31', machine: 'x86_64' }),
        { pythonVersion: '3.9.2', platform: 'x86_64-manylinux_2_31' });
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, version: '3.13.0rc1' }).pythonVersion, '3.13.0');
    // uv가 받는 manylinux 대상은 2_17, 2_28, 2_31~2_40뿐이다
    const platformFor = (libcVersion) => board.resolveTarget({ ...TOS_PROBE, libcVersion }).platform;
    assert.deepStrictEqual(['2.17', '2.27', '2.28', '2.30', '2.31', '2.36', '2.40', '2.41'].map(platformFor),
        ['aarch64-manylinux_2_17', 'aarch64-manylinux_2_17', 'aarch64-manylinux_2_28', 'aarch64-manylinux_2_28',
            'aarch64-manylinux_2_31', 'aarch64-manylinux_2_36', 'aarch64-manylinux_2_40', 'aarch64-manylinux_2_40']);
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, bits: 32 }).error, '32bit', '32-bit Python on a 64-bit kernel');
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, bits: 64 }).platform, 'aarch64-manylinux_2_40');
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, machine: 'armv7l' }).error, 'machine');
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, libc: '', libcVersion: '' }).error, 'libc');
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, implementation: 'PyPy' }).error, 'implementation');
    assert.strictEqual(board.resolveTarget({ ...TOS_PROBE, version: '2.7.18' }).error, 'version');
    assert.deepStrictEqual(board.preferenceLines(TOS_PROBE), ['debugpy==1.8.22', 'psutil==7.2.2', 'packaging==26.3', 'pip==26.2.1']);
    assert.strictEqual(board.isInstalled(TOS_PROBE, 'PsUtil', '7.2.2'), true);
    assert.strictEqual(board.isInstalled(TOS_PROBE, 'jupyter_server', '2.21.1'), false);
});

test('boardScripts: 설치 계획 (있는 것은 설치하지 않음)', () => {
    assert.deepStrictEqual(board.planInstall(TOS_PROBE, 'debug'), { packages: [], runDebug: null, installer: null });
    assert.deepStrictEqual(board.planInstall(TOS_PROBE, 'jupyter'), { packages: ['jupyter_server', 'ipykernel'], runDebug: null, installer: 'wrapper' });
    const bare = { ...TOS_PROBE, pip: null, pipWrapper: false, runDebug: false, runDebugExecutable: false, packages: { debugpy: null, jupyter_server: null, ipykernel: null } };
    assert.deepStrictEqual(board.planInstall(bare, 'debug'), { packages: ['debugpy'], runDebug: 'create', installer: 'pip-wheel' });
    assert.deepStrictEqual(board.planInstall({ ...TOS_PROBE, runDebugExecutable: false }, 'debug'), { packages: [], runDebug: 'chmod', installer: null });
    assert.strictEqual(board.planInstall({ ...TOS_PROBE, pipWrapper: false }, 'jupyter').installer, 'pip');
});

test('boardScripts: root 설치 스크립트 (sudo pip install 형식)', () => {
    const wrapper = board.buildRootInstallScript({ python: '/usr/local/bin/python3', packages: ['jupyter_server', 'ipykernel'], installer: 'wrapper', externallyManaged: true, runDebug: null });
    assert.ok(wrapper.includes(`/usr/local/bin/pip install --no-index --find-links "$WHEELS" --no-cache --compile-bytecode 'jupyter_server' 'ipykernel' || STATUS=$?`));
    assert.ok(!wrapper.includes('run_debug'));
    const pip = board.buildRootInstallScript({ python: '/usr/bin/python3', packages: ['debugpy'], installer: 'pip', externallyManaged: true, runDebug: 'create' });
    assert.ok(pip.includes(`'/usr/bin/python3' -m pip install --no-index --find-links "$WHEELS" --no-cache-dir --disable-pip-version-check --break-system-packages 'debugpy'`));
    assert.ok(pip.includes(`install -m 0755 "$DIR/run_debug.sh" '/usr/local/bin/run_debug.sh'`));
    assert.ok(pip.includes(`if [ ! -e '/usr/local/bin/run_debug.sh' ]`), 'existing run_debug.sh must not be replaced');
    const wheel = board.buildRootInstallScript({ python: '/usr/bin/python3', packages: ['debugpy'], installer: 'pip-wheel', pipWheel: 'pip-25.0.1-py3-none-any.whl', externallyManaged: false, runDebug: 'chmod' });
    assert.ok(wheel.includes(`'/usr/bin/python3' "$WHEELS"/'pip-25.0.1-py3-none-any.whl'/pip install`));
    assert.ok(!wheel.includes('--break-system-packages'));
    assert.ok(wheel.includes(`chmod 0755 '/usr/local/bin/run_debug.sh'`));
    assert.ok(wheel.endsWith('exit $STATUS\n') && !wheel.includes('\r'));
});

test('boardScripts: sudo 비밀번호는 표준 입력 스크립트 안에만', () => {
    const password = `p'a$s "w&d`;
    const script = board.buildInstallScript({ remoteDir: '/tmp/tos-remote.Ab12Cd', password });
    assert.ok(script.includes(`TOS_PW='p'\\''a$s "w&d'`));
    assert.ok(script.includes(`printf '%s\\n' "$TOS_PW" | sudo -S -p '' sh "$DIR/root.sh" "$DIR"`));
    assert.ok(script.includes(`trap 'rm -rf "$DIR"' EXIT`));
    assert.ok(script.includes('sudo -n sh "$DIR/root.sh" "$DIR"'));
    assert.strictEqual(board.parseInstallExit('x\nTOS_INSTALL_EXIT 0\n'), 0);
    assert.strictEqual(board.parseInstallExit('TOS_INSTALL_EXIT 2'), 2);
    assert.strictEqual(board.parseInstallExit('nothing'), undefined);
    const check = board.buildSudoCheckScript('secret');
    assert.ok(check.includes("TOS_PW='secret'") && check.includes(`sudo -S -p '' -v`) && check.includes('sudo -n true'));
    assert.deepStrictEqual(board.parseSudoCheck('TOS_SUDO_OK'), { state: 'ok' });
    assert.deepStrictEqual(board.parseSudoCheck('TOS_SUDO_NEED_PASSWORD\n'), { state: 'need-password' });
    assert.deepStrictEqual(board.parseSudoCheck('TOS_SUDO_DENIED Sorry, try again. '), { state: 'denied', message: 'Sorry, try again.' });
    assert.deepStrictEqual(board.parseSudoCheck(''), { state: 'unknown' });
    assert.strictEqual(board.parseTempDir('/tmp/tos-remote.Ab12Cd\n'), '/tmp/tos-remote.Ab12Cd');
    assert.strictEqual(board.parseTempDir("/tmp/x'; rm -rf /"), undefined);
    assert.strictEqual(board.maskSecrets('pw=secret!', ['secret', 'ab']), 'pw=***!');
    assert.strictEqual(board.maskToken('http://127.0.0.1:8888/?token=abc123 abc123', 'abc123'), 'http://127.0.0.1:8888/?token=*** ***');
});

test('boardScripts: Jupyter 서버 스크립트 (127.0.0.1·토큰·이 확장이 시작한 서버만)', () => {
    const start = board.buildJupyterScript('start', { python: '/usr/local/bin/python3', remoteWorkspace: '/home/tos/My Work', token: 'f00d' });
    assert.ok(start.includes('--ServerApp.ip=127.0.0.1') && start.includes('--ServerApp.port_retries=0'));
    assert.ok(start.includes(`--ServerApp.root_dir='/home/tos/My Work'`) && start.includes(`cd '/home/tos/My Work'`));
    assert.ok(start.includes("JUPYTER_TOKEN='f00d'") && start.includes('export JUPYTER_TOKEN'));
    assert.strictEqual(start.split('f00d').length, 2, 'token appears only in the environment assignment');
    assert.ok(start.includes('setsid "$@"') && start.includes('--ServerApp.terminals_enabled=False'));
    assert.ok(start.includes(`--ServerApp.shutdown_no_activity_timeout=${board.JUPYTER_IDLE_SECONDS}`));
    assert.ok(start.includes('chmod 700 "$STATE"'));
    const stop = board.buildJupyterScript('stop', { python: '/usr/local/bin/python3' });
    assert.ok(stop.includes('kill -TERM "$1"') && stop.includes('rm -f "$STATE/jupyter.port"') && !stop.includes('pkill'));
    assert.ok(board.buildJupyterScript('status', { python: 'p' }).includes('TOS_JUPYTER_STOPPED'));
    assert.ok(board.buildJupyterScript('log', { python: 'p' }).includes('tail -n 200'));
    for (const script of [start, stop]) {
        assert.ok(!script.includes('\r'));
    }
    assert.deepStrictEqual(board.parseJupyterOutput('TOS_JUPYTER_RUNNING 4777 41234 abc\n'), { state: 'running', pid: 4777, port: 41234, token: 'abc' });
    assert.deepStrictEqual(board.parseJupyterOutput('TOS_JUPYTER_STARTED 1 2 t'), { state: 'started', pid: 1, port: 2, token: 't' });
    assert.deepStrictEqual(board.parseJupyterOutput('TOS_JUPYTER_STOPPED'), { state: 'stopped' });
    assert.deepStrictEqual(board.parseJupyterOutput('TOS_JUPYTER_MISSING'), { state: 'missing' });
    assert.deepStrictEqual(board.parseJupyterOutput('TOS_JUPYTER_FAILED\n[E] boom\nTraceback'), { state: 'failed', message: '[E] boom\nTraceback' });
    assert.deepStrictEqual(board.parseJupyterOutput(''), { state: 'unknown' });
});

test('packageResolver: uv 인자·환경과 pylock.toml 읽기', () => {
    const args = compileArgs({ input: 'in.txt', output: 'pylock.toml', constraints: 'c.txt', pythonVersion: '3.12.14', platform: 'aarch64-manylinux_2_40', excludeNewer: '2026-10-01', pylock: true });
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.deepStrictEqual([value('--python-version'), value('--python-platform'), value('--only-binary'), value('--format'), value('--exclude-newer'), value('--output-file')],
        ['3.12.14', 'aarch64-manylinux_2_40', ':all:', 'pylock.toml', '2026-10-01', 'pylock.toml']);
    assert.ok(!compileArgs({ input: 'a', output: 'b', pythonVersion: '3.9.2', platform: 'x' }).includes('--exclude-newer'));
    const env = uvEnv({ cacheDir: 'C:\\c', pythonDir: 'C:\\p' });
    assert.deepStrictEqual([env.UV_CACHE_DIR, env.UV_PYTHON_INSTALL_DIR, env.UV_NO_CONFIG, env.UV_PYTHON_PREFERENCE], ['C:\\c', 'C:\\p', '1', 'only-managed']);
    const sha = (c) => c.repeat(64);
    const lock = [
        'lock-version = "1.0"', 'created-by = "uv"', '',
        '[[packages]]', 'name = "anyio"', 'version = "4.15.1"',
        `wheels = [{ url = "https://files.pythonhosted.org/packages/12/b8/anyio-4.15.1-py3-none-any.whl", upload-time = 2026-09-05T10:42:37Z, size = 132079, hashes = { sha256 = "${sha('a')}" } }]`,
        '', '[[packages]]', 'name = "wcwidth"', 'version = "0.9.2"', 'wheels = [',
        `    { url = "https://files.pythonhosted.org/packages/bc/f0/wcwidth-0.9.2-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.whl", upload-time = 2026-10-05T00:23:32Z, size = 771632, hashes = { sha256 = "${sha('B')}" } },`,
        `    { url = "https://files.pythonhosted.org/packages/9c/b4/wcwidth-0.9.2-py3-none-any.whl", upload-time = 2026-10-05T00:23:21Z, size = 301667, hashes = { sha256 = "${sha('c')}" } },`,
        ']', '', '[[packages]]', 'name = "only-sdist"', 'version = "1.0"',
        `sdist = { url = "https://files.pythonhosted.org/x/only-sdist-1.0.tar.gz", size = 10, hashes = { sha256 = "${sha('d')}" } }`, ''
    ].join('\r\n');
    const packages = parsePylock(lock);
    assert.deepStrictEqual(packages.map((p) => [p.name, p.version, p.wheels.length]), [['anyio', '4.15.1', 1], ['wcwidth', '0.9.2', 2], ['only-sdist', '1.0', 0]]);
    assert.deepStrictEqual(packages[1].wheels[0], {
        url: 'https://files.pythonhosted.org/packages/bc/f0/wcwidth-0.9.2-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.whl',
        filename: 'wcwidth-0.9.2-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.whl',
        sha256: sha('b'),
        size: 771632
    });
    assert.strictEqual(packages[1].wheels[1].size, 301667);
});

test('askpass: 도우미 배치 파일과 일회용 토큰 파이프', async () => {
    const cmd = buildAskpassCmd();
    assert.strictEqual(cmd, '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%TOS_ASKPASS_NODE%" "%TOS_ASKPASS_HELPER%"\r\n');
    assert.ok(/^[\x20-\x7e\r\n]*$/.test(cmd), 'the batch file must be ASCII (cmd reads it in the OEM code page)');
    if (process.platform !== 'win32') {
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-askpass-test-'));
    const broker = new AskpassBroker({ storageDir: dir, nodeExecutable: 'C:\\사용자\\Code.exe', helperScript: 'C:\\사용자\\helper.js' });
    const session = await broker.open('s3cret 비밀');
    const ask = (token) => new Promise((resolve) => {
        const chunks = [];
        const socket = net.connect(session.env.TOS_ASKPASS_PIPE, () => socket.write(`${token}\n`));
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', () => resolve(''));
    });
    try {
        assert.strictEqual(session.env.SSH_ASKPASS_REQUIRE, 'force');
        assert.ok(session.env.DISPLAY, 'OpenSSH 8.1 (Windows 10) uses SSH_ASKPASS only when DISPLAY is set');
        assert.deepStrictEqual([session.env.TOS_ASKPASS_NODE, session.env.TOS_ASKPASS_HELPER], ['C:\\사용자\\Code.exe', 'C:\\사용자\\helper.js']);
        assert.ok(fs.readFileSync(session.env.SSH_ASKPASS, 'utf8').includes('ELECTRON_RUN_AS_NODE'));
        assert.ok(!JSON.stringify(session.env).includes('s3cret'), 'password must not be in the environment');
        assert.strictEqual(await ask('wrong-token'), '');
        assert.strictEqual(await ask(session.env.TOS_ASKPASS_TOKEN), 's3cret 비밀');
        assert.strictEqual(await ask(session.env.TOS_ASKPASS_TOKEN), 's3cret 비밀');
        assert.strictEqual(await ask(session.env.TOS_ASKPASS_TOKEN), '', 'answers are limited');
    } finally {
        session.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------- 다국어 (영어 원문 + 한국어)

const ROOT = path.join(__dirname, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const placeholders = (text) => [...String(text).matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',');

function sourceStrings() {
    const strings = new Set();
    for (const file of fs.readdirSync(path.join(ROOT, 'src')).filter((name) => name.endsWith('.js'))) {
        const code = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
        for (const match of code.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) {
            strings.add(new Function(`return '${match[1]}';`)());
        }
        assert.ok(!/\bt\(\s*[`"]/.test(code), `${file}: t()에는 작은따옴표 문자열만 사용 (번역 추출용)`);
    }
    return strings;
}

test('l10n: 모든 t() 원문에 한국어 번역이 있고 자리표시자가 일치', () => {
    const bundle = readJson('l10n/bundle.l10n.ko.json');
    const strings = sourceStrings();
    const missing = [...strings].filter((s) => !(s in bundle));
    const unused = Object.keys(bundle).filter((k) => !strings.has(k));
    assert.deepStrictEqual(missing, [], `missing Korean translations: ${JSON.stringify(missing)}`);
    assert.deepStrictEqual(unused, [], `unused Korean translations: ${JSON.stringify(unused)}`);
    for (const [source, translated] of Object.entries(bundle)) {
        assert.strictEqual(placeholders(translated), placeholders(source), `placeholder mismatch: ${source}`);
        assert.ok(translated.trim(), `empty translation: ${source}`);
    }
});

test('l10n: package.json %키%가 영어·한국어 nls에 모두 있음', () => {
    const manifest = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    const keys = new Set([...manifest.matchAll(/"%([^"%]+)%"/g)].map((m) => m[1]));
    const en = readJson('package.nls.json');
    const ko = readJson('package.nls.ko.json');
    assert.deepStrictEqual([...keys].filter((k) => !(k in en)), [], 'missing in package.nls.json');
    assert.deepStrictEqual(Object.keys(en).filter((k) => !keys.has(k)), [], 'unused in package.nls.json');
    assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(ko).sort(), 'package.nls.json and package.nls.ko.json keys differ');
    for (const nls of [en, ko]) {
        for (const [key, value] of Object.entries(nls)) {
            if (key.endsWith('.media')) {
                assert.ok(fs.existsSync(path.join(ROOT, value)), `walkthrough media not found: ${value}`);
            }
        }
    }
    assert.ok(!/[가-힣]/.test(manifest), 'package.json에 한국어 문자열이 직접 들어 있음');
});

test('l10n: VS Code 밖에서는 영어 원문에 인자를 채움', () => {
    const { t } = require('../src/i18n');
    assert.strictEqual(t('Run on tOS: {0}', 'a.py'), 'Run on tOS: a.py');
    assert.strictEqual(t('Checking {0}', '{1}'), 'Checking {1}');
});

test('sshTerminal: echo 이스케이프', () => {
    assert.strictEqual(echoLine('a & b | c < d > e ^ f 100%'), 'echo a ^& b ^| c ^< d ^> e ^^ f 100%%');
    const script = buildSshTerminalScript('C:\\ssh.exe', ['-p', '22']);
    assert.ok(script.includes('(%TOS_ATTEMPT%/3)'), 'attempt variable not substituted');
    assert.ok(!script.includes('\u0000'));
});

test('docs: README.md·CHANGELOG.md는 영어(한국어는 *.ko.md)', () => {
    for (const name of ['README.md', 'CHANGELOG.md', ...fs.readdirSync(path.join(ROOT, 'media', 'walkthrough')).filter((n) => n.endsWith('.md')).map((n) => `media/walkthrough/${n}`)]) {
        const lines = fs.readFileSync(path.join(ROOT, name), 'utf8').split(/\r?\n/);
        // 언어 전환 링크([한국어](...))만 허용
        const korean = lines.filter((line) => /[가-힣]/.test(line) && !/^\*\*English\*\* \| \[한국어\]\([^)]+\)$/.test(line.trim()));
        assert.deepStrictEqual(korean, [], `${name} contains Korean text`);
    }
    for (const name of ['README.ko.md', 'CHANGELOG.ko.md']) {
        assert.ok(fs.existsSync(path.join(ROOT, name)), `${name} missing`);
    }
});

test('marketplace: 라이선스·저장소·PNG 아이콘', () => {
    const manifest = readJson('package.json');
    assert.strictEqual(manifest.license, 'GPL-3.0-or-later');
    assert.strictEqual(manifest.repository.url, 'https://github.com/PlanXLab/tOS-Remote.git');
    assert.ok(fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').includes('GNU GENERAL PUBLIC LICENSE'));
    assert.ok(/\.png$/i.test(manifest.icon), 'Marketplace icon must be PNG');
    const png = fs.readFileSync(path.join(ROOT, manifest.icon));
    assert.strictEqual(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(png.readUInt32BE(16) >= 128 && png.readUInt32BE(20) >= 128, 'icon must be at least 128x128');
});

let failed = 0;
(async () => {
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (error) {
            failed++;
            console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
        }
    }
    console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
    process.exitCode = failed ? 1 : 0;
})();
