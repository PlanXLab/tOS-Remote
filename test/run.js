'use strict';

// 의존성 없는 단위 테스트: `node test/run.js` (VS Code API가 필요 없는 모듈만 대상)
const assert = require('assert');
const path = require('path');

const { createMatcher, findLinks } = require('../src/linkParser');
const { obscure, reveal } = require('../src/obscure');
const util = require('../src/util');
const { sftpConnectionString, sftpEnv, compareVersions } = require('../src/rclone');
const { buildWorkspace, sshTerminalArgs } = require('../src/workspaceFile');
const { buildSshTerminalScript, quoteWindowsArg, echoLine } = require('../src/sshTerminal');
const fs = require('fs');
const { buildDebugScript } = require('../src/debugScript');
const { localCachePath, parseDetectedPaths, isRequired, sessionLibraries } = require('../src/pyLibs');

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
for (const { name, fn } of tests) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.log(`  ✗ ${name}\n    ${error.stack.split('\n').slice(0, 3).join('\n    ')}`);
    }
}
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exitCode = failed ? 1 : 0;
