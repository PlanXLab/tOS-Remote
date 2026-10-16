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
const { Syncer, toRelativePosix, isExcluded, DEFAULT_EXCLUDES } = require('../src/syncer');

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
        localWorkspace: 'C:\\Users\\tos\\tOS\\Workspace',
        drive: '',
        target: { host: '10.0.0.2', port: 2222, user: 'tos' },
        remoteWorkspace: "/home/tos/My Work",
        sshPath: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
        sshArgs: ['-p', '2222'],
        libraryCachePaths: ['C:\\cache\\a']
    });
    assert.strictEqual(ws.folders[0].path, 'C:/Users/tos/tOS/Workspace');
    const wsDrive = buildWorkspace({
        drive: 'Y:',
        target: { host: '10.0.0.2', port: 2222, user: 'tos' },
        remoteWorkspace: "/home/tos/My Work",
        sshPath: 'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
        sshArgs: ['-p', '2222'],
        libraryCachePaths: ['C:\\cache\\a']
    });
    assert.strictEqual(wsDrive.folders[0].path, 'Y:/');
    assert.deepStrictEqual(ws.settings['python.analysis.extraPaths'], ['C:/cache/a']);
    const profile = ws.settings['terminal.integrated.profiles.windows'][ws.settings['terminal.integrated.defaultProfile.windows']];
    assert.deepStrictEqual(profile.args.slice(-3), ['-t', 'tos@10.0.0.2', `cd '/home/tos/My Work'; exec $SHELL -l`]);
    assert.strictEqual(profile.overrideName, true, 'the tOS SSH terminal keeps its profile name');
    assert.strictEqual(ws.launch.configurations[0].type, 'tos-remote');
    assert.strictEqual(ws.launch.configurations[0].name, 'tOS: Current File');
    assert.deepStrictEqual(ws.extensions.recommendations, ['ms-python.python', 'ms-python.debugpy']);
    JSON.parse(JSON.stringify(ws));
});

test('debugScript: 포트·경로 인용·루프백 바인딩', () => {
    const script = buildDebugScript({ remoteWorkspace: '/home/tos/Workspace', pythonCommand: 'python3', relativePath: "vision/it's.py", port: 5678 });
    assert.ok(script.includes(':162E '));
    assert.ok(script.includes('--listen 127.0.0.1:5678'));
    assert.ok(script.includes(`--wait-for-client 'vision/it'\\''s.py' &`));
    assert.ok(script.endsWith('wait $P\n'));
    assert.ok(!script.includes('\r'));
});

test('syncer: 상대 경로·제외 규칙·스냅샷과 플러시', async () => {
    const root = path.join('C:', 'work', 'project');
    assert.strictEqual(toRelativePosix(root, path.join(root, 'vision', 'infer.py')), 'vision/infer.py');
    assert.strictEqual(toRelativePosix(root, root), undefined);
    assert.strictEqual(toRelativePosix(root, path.join('C:', 'work', 'other.py')), undefined);

    assert.strictEqual(isExcluded('vision/infer.py'), false);
    assert.strictEqual(isExcluded('.git/config'), true);
    assert.strictEqual(isExcluded('.venv/lib/site.py'), true);
    assert.strictEqual(isExcluded('venv/bin/activate'), true);
    assert.strictEqual(isExcluded('a/__pycache__/b.cpython-312.pyc'), true);
    assert.strictEqual(isExcluded('a/b.pyc'), true);
    assert.strictEqual(isExcluded('a/b.tmp'), true);
    assert.strictEqual(isExcluded('.vscode/settings.json'), true);
    assert.ok(DEFAULT_EXCLUDES.includes('.git/**'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-syncer-test-'));
    const calls = [];
    const isWrite = (c) => c.type === 'rc' && c.command !== 'operations/list' && c.command !== 'operations/stat';
    const remoteEntries = new Map();
    const mockRclone = {
        async runCli(args) {
            calls.push({ type: 'cli', args });
            return { code: 0, stdout: '', stderr: '' };
        },
        async call(command, params) {
            calls.push({ type: 'rc', command, params });
            if (command === 'operations/list') {
                return { list: Array.from(remoteEntries.values()) };
            }
            if (command === 'operations/stat') {
                return { item: remoteEntries.get(params.remote) || null };
            }
            if (command === 'operations/copyfile' && params.dstFs.startsWith(':sftp')) {
                const source = path.join(params.srcFs, ...params.srcRemote.split('/'));
                const stat = fs.statSync(source);
                remoteEntries.set(params.dstRemote, {
                    Path: params.dstRemote,
                    Size: stat.size,
                    ModTime: stat.mtime.toISOString(),
                    IsDir: false
                });
            } else if (command === 'operations/deletefile') {
                remoteEntries.delete(params.remote);
            } else if (command === 'operations/mkdir') {
                remoteEntries.set(params.remote, { Path: params.remote, IsDir: true });
            }
            return {};
        }
    };
    const syncer = new Syncer({
        rclone: mockRclone,
        resolveAuth: async () => ({ type: 'password', obscured: 'OBSCURED' })
    });
    try {
        fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'sub', 'a.py'), 'x = 1\n');
        fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

        await syncer.initialPull(tmpDir, { host: '192.168.254.1', port: 22, user: 'tos' }, { type: 'password', obscured: 'OBSCURED' }, '/home/tos/Workspace');
        assert.strictEqual(calls.filter((c) => c.type === 'cli').length, 1);
        assert.strictEqual(calls[0].args[1], ':sftp:/home/tos/Workspace', 'password must not be in CLI args');

        syncer.startWatch({
            localWorkspace: tmpDir,
            remoteWorkspace: '/home/tos/Workspace',
            host: '192.168.254.1',
            port: 22,
            user: 'tos',
            authType: 'password'
        });

        // 변경이 없으면 flush는 업로드를 수행하지 않는다
        assert.strictEqual(await syncer.flush(5000), true);
        assert.strictEqual(calls.filter(isWrite).length, 0);

        // 파일 수정 및 새 파일 작성 직후 flush하면 감시 타이머를 기다리지 않고 즉시 업로드한다
        fs.writeFileSync(path.join(tmpDir, 'sub', 'a.py'), 'x = 2\n');
        fs.writeFileSync(path.join(tmpDir, 'sub', 'b.py'), 'y = 3\n');
        assert.strictEqual(await syncer.flush(5000), true);
        const rcCalls = calls.filter(isWrite);
        assert.strictEqual(rcCalls.length, 2);
        assert.deepStrictEqual(rcCalls.map((c) => [c.command, c.params.dstRemote]).sort(), [
            ['operations/copyfile', 'sub/a.py'],
            ['operations/copyfile', 'sub/b.py']
        ]);

        // 파일 삭제 후 flush하면 원격 삭제를 호출한다
        fs.unlinkSync(path.join(tmpDir, 'sub', 'b.py'));
        assert.strictEqual(await syncer.flush(5000), true);
        const lastCall = calls.filter(isWrite).at(-1);
        assert.strictEqual(lastCall.command, 'operations/deletefile');
        assert.strictEqual(lastCall.params.remote, 'sub/b.py');

        fs.mkdirSync(path.join(tmpDir, 'empty-folder'));
        assert.strictEqual(await syncer.flush(5000), true);
        const mkdirCall = calls.find((c) => c.command === 'operations/mkdir' && c.params.remote === 'empty-folder');
        assert.ok(mkdirCall, 'empty local directories must be created on the board');
    } finally {
        syncer.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('syncer: remote terminal changes are pulled into the local workspace', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-sync-pull-test-'));
    let remoteEntries = [];
    const remoteFiles = new Map([['new-file.txt', 'created on board'], ['changed.txt', 'original']]);
    const rclone = {
        async call(command, params) {
            if (command === 'operations/list') {
                return { list: remoteEntries };
            }
            if (command === 'operations/copyfile' && path.normalize(params.dstFs) === path.normalize(tmpDir)) {
                const destination = path.join(tmpDir, ...params.dstRemote.split('/'));
                fs.mkdirSync(path.dirname(destination), { recursive: true });
                fs.writeFileSync(destination, remoteFiles.get(params.srcRemote));
            }
            return {};
        },
        async runCli() {
            return { code: 0, stdout: '', stderr: '' };
        }
    };
    const syncer = new Syncer({ rclone, resolveAuth: async () => ({ type: 'key', keyPath: 'key' }) });
    const session = {
        localWorkspace: tmpDir,
        remoteWorkspace: '/home/tos/Workspace',
        host: 'board',
        port: 22,
        user: 'tos',
        authType: 'key'
    };
    try {
        fs.writeFileSync(path.join(tmpDir, 'changed.txt'), 'original');
        syncer.recordSnapshot(tmpDir);
        const timestamp = new Date().toISOString();
        remoteEntries = [
            { Path: 'new-file.txt', Size: 16, ModTime: timestamp, IsDir: false },
            { Path: 'changed.txt', Size: 8, ModTime: timestamp, IsDir: false },
            { Path: 'created-folder', IsDir: true }
        ];
        syncer.startWatch(session);
        for (let attempt = 0; attempt < 20 && !fs.existsSync(path.join(tmpDir, 'new-file.txt')); attempt++) {
            await util.sleep(20);
        }
        assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'new-file.txt'), 'utf8'), 'created on board');
        assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'changed.txt'), 'utf8'), 'original', 'initial inventory must preserve matching workspace content');
        assert.ok(fs.statSync(path.join(tmpDir, 'created-folder')).isDirectory());
        while (syncer.remoteScanRunning) {
            await util.sleep(10);
        }

        remoteFiles.set('changed.txt', 'updated on board');
        remoteEntries = [
            { Path: 'new-file.txt', Size: 16, ModTime: timestamp, IsDir: false },
            { Path: 'changed.txt', Size: 16, ModTime: new Date(Date.now() + 5000).toISOString(), IsDir: false },
            { Path: 'created-folder', IsDir: true }
        ];
        await syncer.syncRemoteChanges();
        assert.strictEqual(fs.readFileSync(path.join(tmpDir, 'changed.txt'), 'utf8'), 'updated on board');
    } finally {
        syncer.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('syncer + rclone: 실제 rclone rcd·SFTP 서버와 양방향 동기화', async () => {
    const { Rclone } = require('../src/rclone');
    const { spawn } = require('child_process');
    const candidates = [
        'D:\\VSCode\\data\\user-data\\User\\globalStorage\\planxlab.tos-remote\\bin\\rclone.exe',
        path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'planxlab.tos-remote', 'bin', 'rclone.exe')
    ];
    const rcloneExe = candidates.find((p) => p && fs.existsSync(p));
    if (!rcloneExe) {
        return;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-sftp-verify-'));
    const serveDir = path.join(work, 'serve');
    const localDir = path.join(work, 'local');
    const storageDir = path.join(work, 'storage');
    const cacheDir = path.join(work, 'cache');
    fs.mkdirSync(serveDir, { recursive: true });

    const port = await util.getFreePort();
    const server = spawn(rcloneExe, ['serve', 'sftp', serveDir, '--addr', `127.0.0.1:${port}`, '--user', 'tos', '--pass', 'secret',
        '--config', 'NUL', '--dir-cache-time', '100ms'], { windowsHide: true });
    for (let i = 0; i < 50; i++) {
        await util.sleep(100);
        const p = await util.probeTcp('127.0.0.1', port, 500);
        if (p.ok && p.banner) {
            break;
        }
    }

    const rclone = new Rclone({ storageDir, cacheDir, getExePath: () => rcloneExe });
    const auth = { type: 'password', obscured: obscure('secret') };
    const target = { host: '127.0.0.1', port, user: 'tos' };
    const syncer = new Syncer({ rclone, resolveAuth: async () => auth });

    try {
        await rclone.ensureDaemon();
        const fsString = sftpConnectionString(target, auth, '/home/tos/Workspace');
        await rclone.mkdir(fsString);
        await syncer.initialPull(localDir, target, auth, '/home/tos/Workspace');

        syncer.startWatch({
            localWorkspace: localDir,
            remoteWorkspace: '/home/tos/Workspace',
            host: '127.0.0.1',
            port,
            user: 'tos',
            authType: 'password'
        });

        const localVision = path.join(localDir, 'vision');
        fs.mkdirSync(localVision, { recursive: true });
        const remoteFile = path.join(serveDir, 'home', 'tos', 'Workspace', 'vision', 'infer.py');
        for (let i = 0; i < 10; i++) {
            const content = `print("hello ${i}")\n`;
            fs.writeFileSync(path.join(localVision, 'infer.py'), content);
            const flushed = await syncer.flush(10000);
            assert.strictEqual(flushed, true, `flush ${i} failed`);
            assert.strictEqual(fs.readFileSync(remoteFile, 'utf8'), content, `content ${i} mismatch`);
        }

        fs.unlinkSync(path.join(localVision, 'infer.py'));
        assert.strictEqual(await syncer.flush(10000), true);
        assert.strictEqual(fs.existsSync(remoteFile), false, 'remote file should be deleted');
        assert.strictEqual(fs.existsSync(path.join(localVision, 'infer.py')), false, 'deleted local file must not be pulled back');

        // Explorer: empty local folder → board
        fs.mkdirSync(path.join(localDir, 'from_explorer'));
        assert.strictEqual(await syncer.flush(10000), true);
        assert.ok(fs.statSync(path.join(serveDir, 'home', 'tos', 'Workspace', 'from_explorer')).isDirectory(), 'local folder must be created on the board');

        // Remote terminal: folder and file created on the board → local
        fs.mkdirSync(path.join(serveDir, 'home', 'tos', 'Workspace', 'from_terminal', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(serveDir, 'home', 'tos', 'Workspace', 'from_terminal', 'note.txt'), 'terminal');
        await util.sleep(300);
        await syncer.syncRemoteChanges();
        assert.ok(fs.statSync(path.join(localDir, 'from_terminal', 'sub')).isDirectory(), 'board folder must appear locally');
        assert.strictEqual(fs.readFileSync(path.join(localDir, 'from_terminal', 'note.txt'), 'utf8'), 'terminal');

        fs.writeFileSync(path.join(serveDir, 'home', 'tos', 'Workspace', 'from_board.txt'), 'board-data');
        await syncer.initialPull(localDir, target, auth, '/home/tos/Workspace');
        assert.strictEqual(fs.readFileSync(path.join(localDir, 'from_board.txt'), 'utf8'), 'board-data');
    } finally {
        syncer.dispose();
        await rclone.quitDaemon().catch(() => {});
        server.kill();
        await util.sleep(300);
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('remoteTerminal: 로컬 셸 터미널 판별', () => {
    const { isLocalShellTerminal } = require('../src/remoteTerminal');
    const script = 'C:\\Users\\a b\\AppData\\Roaming\\Code\\User\\globalStorage\\planxlab.tos-remote\\ssh-terminal.cmd';
    const prefixes = ['Run on tOS: '];
    assert.strictEqual(isLocalShellTerminal({ name: 'powershell', creationOptions: {} }, script, prefixes), true);
    assert.strictEqual(isLocalShellTerminal({ name: 'pwsh', creationOptions: { shellPath: 'pwsh.exe' } }, script, prefixes), true);
    assert.strictEqual(isLocalShellTerminal({ name: 'tOS SSH', creationOptions: {} }, script, prefixes), false);
    assert.strictEqual(isLocalShellTerminal({ name: 'cmd', creationOptions: { shellArgs: ['/d', '/c', script.toUpperCase()] } }, script, prefixes), false);
    assert.strictEqual(isLocalShellTerminal({ name: 'Run on tOS: a.py', creationOptions: {} }, script, prefixes), false);
    assert.strictEqual(isLocalShellTerminal({ name: 'x', creationOptions: { pty: {} } }, script, prefixes), false);
    assert.strictEqual(isLocalShellTerminal({ name: 'x', creationOptions: { hideFromUser: true } }, script, prefixes), false);
});

test('remoteTerminal: 복원된 로컬 터미널을 원격 터미널로 교체', () => {
    const Module = require('module');
    const created = [];
    let openListener;
    const makeTerminal = (name, creationOptions = {}) => ({
        name, creationOptions, exitStatus: undefined, disposed: false, shown: false,
        dispose() { this.disposed = true; },
        show() { this.shown = true; }
    });
    const restored = makeTerminal('powershell');
    const fakeVscode = {
        window: {
            terminals: [restored],
            activeTerminal: restored,
            onDidOpenTerminal: (fn) => { openListener = fn; return { dispose() { if (openListener === fn) { openListener = undefined; } } }; },
            onDidCloseTerminal: () => ({ dispose() {} }),
            createTerminal(options) {
                const terminal = makeTerminal(options.name, options);
                created.push(terminal);
                fakeVscode.window.terminals.push(terminal);
                return terminal;
            }
        },
        ThemeIcon: class { constructor(id) { this.id = id; } }
    };
    const load = Module._load;
    const modulePath = require.resolve('../src/remoteTerminal');
    delete require.cache[modulePath];
    Module._load = function (request, ...rest) {
        return request === 'vscode' ? fakeVscode : load.call(this, request, ...rest);
    };
    let guard;
    try {
        const { RemoteTerminalGuard } = require('../src/remoteTerminal');
        guard = new RemoteTerminalGuard({ graceMs: 1000000, excludedNamePrefixes: ['Run on tOS: '] });
        guard.begin();
        // 세션 준비 전에 VS Code가 자동으로 만든 터미널도 모은다
        const autoCreated = makeTerminal('pwsh');
        openListener(autoCreated);
        assert.strictEqual(restored.disposed, false, 'nothing is replaced before the session is ready');

        const launch = { shellPath: 'C:\\Windows\\System32\\cmd.exe', shellArgs: ['/d', '/c', 'C:\\s\\ssh-terminal.cmd'], scriptPath: 'C:\\s\\ssh-terminal.cmd' };
        guard.activate(launch);
        assert.strictEqual(restored.disposed, true);
        assert.strictEqual(autoCreated.disposed, true);
        assert.strictEqual(created.length, 1, 'only one board connection is opened');
        assert.deepStrictEqual([created[0].name, created[0].creationOptions.shellPath, created[0].creationOptions.shellArgs],
            ['tOS SSH', launch.shellPath, launch.shellArgs]);
        assert.strictEqual(created[0].shown, true, 'the remote terminal takes the place of the active terminal');

        // 잠시 동안 늦게 복원되는 로컬 터미널은 기존 원격 터미널로 대체하고, 원격·작업 터미널은 그대로 둔다
        const late = makeTerminal('powershell');
        openListener(late);
        assert.strictEqual(late.disposed, true);
        assert.strictEqual(created.length, 1, 'the existing remote terminal is reused');
        const task = makeTerminal('Run on tOS: a.py');
        openListener(task);
        assert.strictEqual(task.disposed, false);
        openListener(created[0]);
        assert.strictEqual(created[0].disposed, false);

        // 유예 시간이 끝난 뒤 사용자가 연 로컬 터미널은 건드리지 않는다
        guard.stop();
        assert.strictEqual(openListener, undefined, 'stops listening after the grace period');
    } finally {
        Module._load = load;
        if (guard) {
            guard.dispose();
        }
        delete require.cache[modulePath];
    }
});

test('jupyterKernel: 컨트롤러 ID 규칙 (노트북·Interactive 창)', () => {
    const { baseControllerId, controllerIdFor, boardKey, KERNEL_NOTEBOOK_TYPES } = require('../src/jupyterKernel');
    const base = 'jupyter-remote?id=tos-remote&handle=tos-remote.python3.usr\\bin\\python3..-m#ipykernel_launcher';
    assert.strictEqual(controllerIdFor(base, 'jupyter-notebook'), base);
    assert.strictEqual(controllerIdFor(base, 'interactive'), `${base} (Interactive)`);
    assert.strictEqual(baseControllerId(`${base} (Interactive)`), base);
    assert.strictEqual(baseControllerId(base), base);
    assert.strictEqual(boardKey({ user: 'tos', host: '192.168.254.1', port: 22 }), 'tos@192.168.254.1:22');
    assert.strictEqual(boardKey(undefined), undefined);
    assert.ok(KERNEL_NOTEBOOK_TYPES.has('jupyter-notebook') && KERNEL_NOTEBOOK_TYPES.has('interactive'));
});

test('jupyter: 커널 자동 선택 (처음 한 번 기억 → 이후 창 없이 선택)', async () => {
    const Module = require('module');
    const calls = [];
    let selectResults = [];
    let pickResult;
    const notebook = { uri: { toString: () => 'file:///w/a.ipynb' }, notebookType: 'jupyter-notebook' };
    const interactive = { uri: { toString: () => 'vscode-interactive:/i-1' }, notebookType: 'interactive' };
    class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
    const fakeVscode = {
        EventEmitter,
        window: { activeNotebookEditor: { notebook } },
        workspace: { getConfiguration: () => ({ get: (key, fallback) => fallback }) },
        extensions: { getExtension: () => ({}) },
        commands: {
            async executeCommand(command, ...args) {
                calls.push([command, ...args]);
                if (command === 'notebook.selectKernel') {
                    return selectResults.length ? selectResults.shift() : true;
                }
                if (command === 'jupyter.kernel.selectJupyterServerKernel') {
                    return args[0] === 'PlanXLab.tos-remote' ? pickResult : undefined;
                }
                return undefined;
            }
        }
    };
    const memento = new Map();
    const sessionMgr = {
        isOwnerWindow: () => true,
        readSession: () => ({ user: 'tos', host: '10.0.0.2', port: 22 }),
        context: {
            extension: { id: 'PlanXLab.tos-remote' },
            globalState: { get: (key) => memento.get(key), update: async (key, value) => memento.set(key, value) }
        }
    };
    const load = Module._load;
    const modulePath = require.resolve('../src/jupyter');
    delete require.cache[modulePath];
    Module._load = function (request, ...rest) {
        return request === 'vscode' ? fakeVscode : load.call(this, request, ...rest);
    };
    try {
        const { JupyterManager } = require('../src/jupyter');
        const manager = new JupyterManager({ log: { info() {}, warn() {}, debug() {} }, ssh: {}, sessionMgr, boardTools: {} });
        manager.prepareForCells = async () => true;
        manager.registerCollection = async () => { manager.collection = {}; };

        // 처음: Jupyter 확장의 tOS Remote 커널 목록에서 한 번 고르고 기억한다
        pickResult = 'BASE';
        await manager.autoSelectKernel(notebook);
        assert.deepStrictEqual(calls.map((c) => c[0]), ['jupyter.kernel.selectJupyterServerKernel', 'notebook.selectKernel']);
        assert.deepStrictEqual(calls[0].slice(1), ['PlanXLab.tos-remote', 'tos-remote', notebook]);
        assert.deepStrictEqual(calls[1][1], { id: 'BASE', extension: 'ms-toolsai.jupyter' });
        assert.deepStrictEqual(memento.get('tosRemote.jupyterKernelIds'), { 'tos@10.0.0.2:22': 'BASE' });

        // 이후: Interactive 창도 기억한 커널로 창 없이 선택 (컨트롤러가 준비될 때까지 다시 시도)
        calls.length = 0;
        fakeVscode.window.activeNotebookEditor = { notebook: interactive };
        selectResults = [false, true];
        await manager.autoSelectKernel(interactive);
        assert.deepStrictEqual(calls.map((c) => c[0]), ['notebook.selectKernel', 'notebook.selectKernel']);
        assert.deepStrictEqual(calls[1][1], { id: 'BASE (Interactive)', extension: 'ms-toolsai.jupyter' });

        // 다른 편집기로 옮겨 가면 선택하지 않는다
        calls.length = 0;
        fakeVscode.window.activeNotebookEditor = undefined;
        await manager.autoSelectKernel(notebook);
        assert.strictEqual(calls.length, 0);

        // 문서마다 한 번만 처리한다 (사용자가 직접 바꾼 커널을 다시 바꾸지 않음)
        let runs = 0;
        manager.autoSelectKernel = async () => { runs++; };
        manager.onActiveNotebookEditor({ notebook });
        manager.onActiveNotebookEditor({ notebook });
        manager.onActiveNotebookEditor({ notebook: { uri: { toString: () => 'file:///w/a.py' }, notebookType: 'other' } });
        assert.strictEqual(runs, 1);
    } finally {
        Module._load = load;
        delete require.cache[modulePath];
    }
});

test('walkthrough: Mark Done 없이 실제 상태로 단계 완료', async () => {
    const { WalkthroughState, walkthroughContext } = require('../src/walkthrough');
    const target = { host: '192.168.254.1', port: 22, user: 'tos' };
    assert.deepStrictEqual(walkthroughContext({ target, keyOk: false, connectionOk: false, workspaceOpened: false }),
        { 'tosRemote.sshKeyReady': false, 'tosRemote.boardConnected': false, 'tosRemote.workspaceOpened': false });
    assert.strictEqual(walkthroughContext({ target, keyOk: true, connectionOk: false, workspaceOpened: false })['tosRemote.boardConnected'], true,
        'a working SSH key means the connection works');
    assert.strictEqual(walkthroughContext({ target: undefined, keyOk: false, connectionOk: false, workspaceOpened: true })['tosRemote.boardConnected'], true);

    // VS Code를 다시 시작해도 저장된 결과로 완료 상태가 유지되고, 바뀐 키만 다시 알린다
    const memento = new Map();
    const globalState = { get: (key) => memento.get(key), update: async (key, value) => memento.set(key, value) };
    const set = [];
    const state = new WalkthroughState({ globalState, setContext: (key, value) => set.push([key, value]) });
    state.update({ target, keyOk: false });
    assert.strictEqual(set.length, 3);
    await state.markConnected(target);
    await state.markOpened();
    set.length = 0;
    state.update({ target, keyOk: false });
    assert.deepStrictEqual(set, [['tosRemote.boardConnected', true], ['tosRemote.workspaceOpened', true]]);
    set.length = 0;
    state.update({ target, keyOk: false });
    assert.deepStrictEqual(set, [], 'unchanged keys are not set again');
    const restarted = new WalkthroughState({ globalState, setContext: () => {} });
    assert.strictEqual(restarted.update({ target, keyOk: false })['tosRemote.workspaceOpened'], true);

    // 매니페스트의 완료 조건은 이 모듈이 설정하는 키(또는 rclone 점검 키)만 사용하고, WinFsp 단계는 없다
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const steps = manifest.contributes.walkthroughs[0].steps;
    assert.deepStrictEqual(steps.map((s) => s.id), ['rclone', 'board', 'sshKey', 'open']);
    const known = new Set(['tosRemote.rcloneReady', ...Object.keys(walkthroughContext({}))]);
    for (const step of steps) {
        for (const event of step.completionEvents) {
            assert.ok(event.startsWith('onContext:') && known.has(event.slice('onContext:'.length)), `${step.id}: ${event}`);
        }
    }
    assert.ok(!JSON.stringify(manifest).toLowerCase().includes('winfsp'), 'WinFsp is no longer installed');
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

test('sshTerminal: tOS에서 실행 배치 파일 (명령줄 숨김·종료 메시지·키 입력 대기)', () => {
    const script = buildRunScript();
    const lines = script.split('\r\n');
    assert.ok(lines.includes('setlocal EnableDelayedExpansion'));
    assert.ok(lines.includes('!TOS_SSH_EXE! !TOS_SSH_ARGS!'), 'ssh must come from environment variables');
    assert.ok(lines.includes('if not "%TOS_EXIT%"=="255" goto terminated'));
    assert.ok(lines.includes('pause >nul'));
    assert.ok(script.includes('Terminated, press any key to close the terminal.'));
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
