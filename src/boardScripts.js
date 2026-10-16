'use strict';

// 보드에서 실행하는 스크립트와 출력 해석 (VS Code API 없이 단위 테스트할 수 있게 분리)
// 비밀값(sudo 비밀번호, Jupyter 토큰)은 ssh 'sh -s'의 표준 입력으로 보내는 스크립트 안에만 넣는다.
// 원격 명령줄·로그·파일에는 남기지 않는다.
const { shellQuote } = require('./util');

const RUN_DEBUG_PATH = '/usr/local/bin/run_debug.sh';

// tOS-Lite 1.0 이미지의 /usr/local/bin/run_debug.sh와 같은 내용. 보드에 없을 때만 만든다(실행 권한 0755).
const RUN_DEBUG_SCRIPT = [
    '#!/bin/sh',
    'pkill -f debugpy',
    'echo "DEBUG_START"',
    'python3 -u -Xfrozen_modules=off -m debugpy --listen 0.0.0.0:5678 --wait-for-client "$1" &',
    'PID=$!',
    'sleep 0.5',
    'echo "DEBUG_READY"',
    'wait $PID',
    ''
].join('\n');

// 보드 도구 그룹별 전역 Python 패키지 (모듈 이름 = 배포 이름)
const GROUP_PACKAGES = {
    debug: ['debugpy'],
    jupyter: ['jupyter_server', 'ipykernel']
};

// 검증한 주 버전 범위. 보드 Python 버전에 맞는 최신 호환 버전을 이 범위 안에서 고른다.
const CONSTRAINTS = ['jupyter_server>=2,<3', 'ipykernel>=6,<8', 'debugpy>=1.6,<2'];

const MARK = {
    tools: 'TOS_TOOLS',
    toolsError: 'TOS_TOOLS_ERROR',
    sudoOk: 'TOS_SUDO_OK',
    sudoNeedPassword: 'TOS_SUDO_NEED_PASSWORD',
    sudoDenied: 'TOS_SUDO_DENIED',
    installing: 'TOS_INSTALLING',
    installExit: 'TOS_INSTALL_EXIT',
    runDebugCreated: 'TOS_RUN_DEBUG_CREATED',
    runDebugFixed: 'TOS_RUN_DEBUG_FIXED'
};

// 보드 Python으로 실행하는 도구 확인 스크립트. 한 줄의 "TOS_TOOLS<TAB>JSON"을 출력한다.
// Python 3.6 문법까지 지원하도록 f-string을 쓰지 않는다. sudo는 여기서 확인하지 않는다(인증 로그를 남기지 않도록).
const TOOLS_PROBE_PY = [
    'import json, os, platform, re, site, struct, sys, sysconfig',
    'try:',
    '    from importlib import metadata as tos_md',
    'except ImportError:',
    '    tos_md = None',
    'try:',
    '    from importlib.util import find_spec as tos_find_spec',
    'except ImportError:',
    '    tos_find_spec = None',
    'def tos_version(name):',
    '    try:',
    '        if tos_find_spec is None or tos_find_spec(name) is None:',
    '            return None',
    '    except Exception:',
    '        return None',
    '    if tos_md is not None:',
    '        try:',
    '            return tos_md.version(name)',
    '        except Exception:',
    '            pass',
    '    return "?"',
    // root로 실행하는 설치는 사용자 site-packages(~/.local)를 보지 못하므로 설치 버전 목록(선호값·다운로드 생략)에서 뺀다
    'def tos_distributions():',
    '    result = {}',
    '    if tos_md is None:',
    '        return result',
    '    try:',
    '        user_site = site.getusersitepackages()',
    '    except Exception:',
    '        user_site = None',
    '    paths = [p for p in sys.path if not (user_site and p.startswith(user_site))]',
    '    for dist in tos_md.distributions(path=paths):',
    '        try:',
    '            name = dist.metadata["Name"]',
    '            if name:',
    '                result[re.sub(r"[-_.]+", "-", name).lower()] = dist.version',
    '        except Exception:',
    '            pass',
    '    return result',
    'def tos_tools():',
    '    try:',
    '        libc, libc_version = os.confstr("CS_GNU_LIBC_VERSION").split()[:2]',
    '    except Exception:',
    '        libc, libc_version = platform.libc_ver()',
    '    wrapper = False',
    '    try:',
    '        with open("/usr/local/bin/pip", "rb") as f:',
    '            head = f.read(8192)',
    '        wrapper = b"uv pip" in head and b"--break-system-packages" in head and os.path.realpath("/usr/local/bin/python3") == os.path.realpath(sys.executable)',
    '    except Exception:',
    '        pass',
    `    run_debug = "${RUN_DEBUG_PATH}"`,
    '    return {',
    '        "python": sys.executable,',
    '        "version": platform.python_version(),',
    '        "implementation": platform.python_implementation(),',
    '        "machine": platform.machine(),',
    // 64비트 커널에서 32비트 Python을 쓰면 machine은 aarch64로 보이므로 포인터 크기로 구분한다
    '        "bits": struct.calcsize("P") * 8,',
    '        "libc": libc,',
    '        "libcVersion": libc_version,',
    '        "externallyManaged": os.path.isfile(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED")),',
    '        "pip": tos_version("pip"),',
    '        "pipWrapper": wrapper,',
    '        "packages": dict((name, tos_version(name)) for name in ("debugpy", "jupyter_server", "ipykernel")),',
    '        "runDebug": os.path.isfile(run_debug),',
    '        "runDebugExecutable": os.access(run_debug, os.X_OK),',
    '        "distributions": tos_distributions()',
    '    }',
    'try:',
    `    print("${MARK.tools}\\t" + json.dumps(tos_tools()))`,
    'except Exception as error:',
    `    print("${MARK.toolsError}\\t" + str(error))`
].join('\n');

/** 보드에서 도구 확인 스크립트를 실행하는 명령. pythonCommand는 실행/디버그와 같이 셸 명령으로 쓴다. */
function buildProbeCommand(pythonCommand) {
    return `${pythonCommand || 'python3'} -c ${shellQuote(TOOLS_PROBE_PY)}`;
}

function normalizeProbe(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.python !== 'string' || !raw.python) {
        return undefined;
    }
    const packages = raw.packages && typeof raw.packages === 'object' ? raw.packages : {};
    return {
        python: raw.python,
        version: String(raw.version || ''),
        implementation: String(raw.implementation || ''),
        machine: String(raw.machine || ''),
        bits: Number(raw.bits) || null,
        libc: String(raw.libc || ''),
        libcVersion: String(raw.libcVersion || ''),
        externallyManaged: !!raw.externallyManaged,
        pip: raw.pip || null,
        pipWrapper: !!raw.pipWrapper,
        packages: Object.fromEntries(Object.values(GROUP_PACKAGES).flat().map((name) => [name, packages[name] || null])),
        runDebug: !!raw.runDebug,
        runDebugExecutable: !!raw.runDebugExecutable,
        distributions: raw.distributions && typeof raw.distributions === 'object' ? raw.distributions : {}
    };
}

/** 도구 확인 출력에서 결과를 꺼낸다. 확인 스크립트 자체가 실패하면 {error}를 돌려준다. */
function parseProbeOutput(stdout) {
    for (const line of String(stdout || '').split(/\r?\n/)) {
        if (line.startsWith(`${MARK.tools}\t`)) {
            try {
                return normalizeProbe(JSON.parse(line.slice(MARK.tools.length + 1)));
            } catch {
                return undefined;
            }
        }
        if (line.startsWith(`${MARK.toolsError}\t`)) {
            return { error: line.slice(MARK.toolsError.length + 1) };
        }
    }
    return undefined;
}

/** 패널·명령에서 쓰는 도구 상태 */
function toolStatus(probe) {
    if (!probe || probe.error) {
        return undefined;
    }
    const p = probe.packages;
    return {
        debug: {
            ready: !!p.debugpy && probe.runDebug && probe.runDebugExecutable,
            debugpy: p.debugpy,
            runDebug: probe.runDebug && probe.runDebugExecutable
        },
        jupyter: {
            ready: !!p.jupyter_server && !!p.ipykernel,
            jupyterServer: p.jupyter_server,
            ipykernel: p.ipykernel
        }
    };
}

// uv --python-platform이 받는 manylinux 대상: 2_17, 2_28, 2_31~2_40. 보드 glibc 이하 중 가장 높은 대상을 쓴다(하위 호환).
const MAX_MANYLINUX_MINOR = 40;

function manylinuxMinor(glibcMinor) {
    if (glibcMinor >= 31) {
        return Math.min(glibcMinor, MAX_MANYLINUX_MINOR);
    }
    return glibcMinor >= 28 ? 28 : 17;
}

/**
 * 보드 Python에 맞춘 uv 해석 대상.
 * @returns {{pythonVersion: string, platform: string} | {error: 'implementation'|'version'|'32bit'|'machine'|'libc'}}
 */
function resolveTarget(probe) {
    if (probe.implementation && probe.implementation !== 'CPython') {
        return { error: 'implementation' };
    }
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(probe.version);
    if (!version || version[1] !== '3') {
        return { error: 'version' };
    }
    if (probe.bits === 32) {
        return { error: '32bit' };
    }
    const arch = { aarch64: 'aarch64', arm64: 'aarch64', x86_64: 'x86_64', amd64: 'x86_64' }[probe.machine.toLowerCase()];
    if (!arch) {
        return { error: 'machine' };
    }
    const libc = /^(\d+)\.(\d+)/.exec(probe.libcVersion);
    if (probe.libc !== 'glibc' || !libc || libc[1] !== '2' || Number(libc[2]) < 17) {
        return { error: 'libc' };
    }
    return {
        pythonVersion: `${version[1]}.${version[2]}.${version[3]}`,
        platform: `${arch}-manylinux_2_${manylinuxMinor(Number(libc[2]))}`
    };
}

/** PEP 503 이름 정규화 */
function normalizeName(name) {
    return String(name).replace(/[-_.]+/g, '-').toLowerCase();
}

/** 이미 설치된 버전을 uv 선호값(requirements 형식)으로 만든다. 이름·버전 형식이 이상한 항목은 뺀다. */
function preferenceLines(probe) {
    return Object.entries(probe.distributions || {})
        .filter(([name, version]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && /^[A-Za-z0-9][A-Za-z0-9.+!_-]*$/.test(String(version)))
        .map(([name, version]) => `${name}==${version}`);
}

function isInstalled(probe, name, version) {
    return (probe.distributions || {})[normalizeName(name)] === version;
}

/**
 * 설치 계획. 이미 있는 패키지는 설치하지 않는다.
 * installer: wrapper(tOS의 sudo pip = uv, 전역) | pip(python -m pip) | pip-wheel(pip이 없으면 pip 휠에서 직접 실행)
 */
function planInstall(probe, group) {
    const packages = (GROUP_PACKAGES[group] || []).filter((name) => !probe.packages[name]);
    let runDebug = null;
    if (group === 'debug' || packages.length) {
        runDebug = !probe.runDebug ? 'create' : !probe.runDebugExecutable ? 'chmod' : null;
    }
    let installer = null;
    if (packages.length) {
        installer = probe.pipWrapper ? 'wrapper' : probe.pip ? 'pip' : 'pip-wheel';
    }
    return { packages, runDebug, installer };
}

/**
 * root로 실행하는 설치 스크립트 (sudo sh root.sh <작업 폴더>). 휠은 <작업 폴더>/wheels에 있다.
 * @param {{python: string, packages: string[], installer: string|null, pipWheel?: string,
 *          externallyManaged: boolean, runDebug: string|null}} plan
 */
function buildRootInstallScript(plan) {
    const lines = ['#!/bin/sh', 'set -u', 'DIR=$1', 'WHEELS="$DIR/wheels"', 'STATUS=0'];
    if (plan.packages.length) {
        const names = plan.packages.map(shellQuote).join(' ');
        let command;
        if (plan.installer === 'wrapper') {
            // tOS의 /usr/local/bin/pip: root로 실행하면 uv pip install --python /usr/local/bin/python3 --break-system-packages
            command = `/usr/local/bin/pip install --no-index --find-links "$WHEELS" --no-cache --compile-bytecode ${names}`;
        } else {
            const pip = plan.installer === 'pip-wheel'
                ? `${shellQuote(plan.python)} "$WHEELS"/${shellQuote(plan.pipWheel)}/pip`
                : `${shellQuote(plan.python)} -m pip`;
            const breakSystem = plan.externallyManaged ? ' --break-system-packages' : '';
            command = `${pip} install --no-index --find-links "$WHEELS" --no-cache-dir --disable-pip-version-check${breakSystem} ${names}`;
        }
        lines.push(`echo ${MARK.installing}`, `${command} || STATUS=$?`);
    }
    const target = shellQuote(RUN_DEBUG_PATH);
    if (plan.runDebug === 'create') {
        lines.push(`if [ ! -e ${target} ]; then install -m 0755 "$DIR/run_debug.sh" ${target} && echo ${MARK.runDebugCreated} || STATUS=1; fi`);
    } else if (plan.runDebug === 'chmod') {
        lines.push(`chmod 0755 ${target} && echo ${MARK.runDebugFixed} || STATUS=1`);
    }
    lines.push('exit $STATUS', '');
    return lines.join('\n');
}

/** 사용자 권한으로 실행해 root 설치 스크립트를 sudo로 돌리고, 끝나면 작업 폴더를 지운다. */
function buildInstallScript({ remoteDir, password }) {
    return [
        `DIR=${shellQuote(remoteDir)}`,
        `TOS_PW=${shellQuote(password || '')}`,
        `trap 'rm -rf "$DIR"' EXIT`,
        'if [ -n "$TOS_PW" ]; then',
        `    printf '%s\\n' "$TOS_PW" | sudo -S -p '' sh "$DIR/root.sh" "$DIR"`,
        'else',
        '    sudo -n sh "$DIR/root.sh" "$DIR"',
        'fi',
        `echo "${MARK.installExit} $?"`,
        ''
    ].join('\n');
}

/** sudo 사용 가능 여부 확인. 비밀번호 없이 되면 OK, 비밀번호가 필요하면 NEED, 주어진 비밀번호가 틀리면 DENIED <메시지> */
function buildSudoCheckScript(password) {
    return [
        `TOS_PW=${shellQuote(password || '')}`,
        `if sudo -n true 2>/dev/null; then echo ${MARK.sudoOk}; exit 0; fi`,
        `if [ -z "$TOS_PW" ]; then echo ${MARK.sudoNeedPassword}; exit 0; fi`,
        `if ERR=$(printf '%s\\n' "$TOS_PW" | sudo -S -p '' -v 2>&1 >/dev/null); then echo ${MARK.sudoOk}; exit 0; fi`,
        `echo "${MARK.sudoDenied} $(printf '%s' "$ERR" | tr '\\n' ' ')"`,
        ''
    ].join('\n');
}

/** @returns {{state: 'ok'|'need-password'|'denied'|'unknown', message?: string}} */
function parseSudoCheck(stdout) {
    for (const line of String(stdout || '').split(/\r?\n/)) {
        if (line === MARK.sudoOk) {
            return { state: 'ok' };
        }
        if (line === MARK.sudoNeedPassword) {
            return { state: 'need-password' };
        }
        if (line.startsWith(MARK.sudoDenied)) {
            return { state: 'denied', message: line.slice(MARK.sudoDenied.length).trim() };
        }
    }
    return { state: 'unknown' };
}

/** @returns {number|undefined} 설치 스크립트의 종료 코드 */
function parseInstallExit(stdout) {
    const match = new RegExp(`^${MARK.installExit} (\\d+)\\s*$`, 'm').exec(String(stdout || ''));
    return match ? Number(match[1]) : undefined;
}

// 업로드할 임시 폴더 (권한 0700)
const MKTEMP_COMMAND = 'mktemp -d /tmp/tos-remote.XXXXXX';

function parseTempDir(stdout) {
    const line = String(stdout || '').trim().split(/\r?\n/).pop() || '';
    return /^\/tmp\/tos-remote\.[A-Za-z0-9]+$/.test(line) ? line : undefined;
}

// ---------------------------------------------------------------- Jupyter 서버

// 보드의 상태 폴더 (권한 0700). jupyter.port에 이 확장이 시작한 서버의 포트를 기록한다.
const JUPYTER_STATE_DIR = '${XDG_STATE_HOME:-$HOME/.local/state}/tos-remote';
// 연결이 없는 커널을 정리하고, 커널·요청이 없으면 서버를 끝낼 때까지의 시간 (VS Code가 비정상 종료된 경우 대비)
const JUPYTER_IDLE_SECONDS = 3600;

// 이 확장이 시작한 서버 찾기: jupyter.port와 같은 포트의 런타임 파일(jpserver-<pid>.json)이 있고 pid가 살아 있으면 "pid port token"
const FIND_SERVER_PY = [
    'import glob, json, os, sys',
    'try:',
    '    from jupyter_core.paths import jupyter_runtime_dir',
    '    runtime = jupyter_runtime_dir()',
    'except Exception:',
    '    sys.exit(1)',
    'port = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0',
    'for path in glob.glob(os.path.join(runtime, "jpserver-*.json")):',
    '    try:',
    '        with open(path) as f:',
    '            info = json.load(f)',
    '        if port and int(info.get("port", 0)) == port:',
    '            os.kill(int(info["pid"]), 0)',
    '            print("%s %s %s" % (info["pid"], port, info.get("token", "")))',
    '            sys.exit(0)',
    '    except SystemExit:',
    '        raise',
    '    except Exception:',
    '        pass',
    'sys.exit(1)'
].join('\n');

const FREE_PORT_PY = 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()';

/**
 * Jupyter 서버 제어 스크립트 (ssh 'sh -s'의 표준 입력으로 전달)
 * - status: 실행 중이면 TOS_JUPYTER_RUNNING <pid> <port> <token>, 아니면 TOS_JUPYTER_STOPPED
 * - start: 실행 중이면 RUNNING, 아니면 127.0.0.1의 빈 포트로 백그라운드 시작 후 TOS_JUPYTER_STARTED <pid> <port> <token>
 * - stop: 이 확장이 시작한 서버만 끝낸다 (SIGTERM → 최대 10초 → SIGKILL)
 * - log: 서버 로그 마지막 부분
 * @param {'status'|'start'|'stop'|'log'} action
 * @param {{python: string, remoteWorkspace?: string, token?: string}} options
 */
function buildJupyterScript(action, options) {
    const lines = [
        `PY=${shellQuote(options.python)}`,
        `STATE="${JUPYTER_STATE_DIR}"`,
        'mkdir -p "$STATE" && chmod 700 "$STATE"',
        `find_server() { "$PY" -c ${shellQuote(FIND_SERVER_PY)} "$(cat "$STATE/jupyter.port" 2>/dev/null)" 2>/dev/null; }`
    ];
    if (action === 'log') {
        lines.push('tail -n 200 "$STATE/jupyter.log" 2>/dev/null', '');
        return lines.join('\n');
    }
    lines.push('INFO=$(find_server)');
    if (action === 'status') {
        lines.push('if [ -n "$INFO" ]; then echo "TOS_JUPYTER_RUNNING $INFO"; else echo TOS_JUPYTER_STOPPED; fi', '');
    } else if (action === 'stop') {
        lines.push(
            'if [ -n "$INFO" ]; then',
            '    set -- $INFO',
            '    kill -TERM "$1" 2>/dev/null',
            '    i=0; while kill -0 "$1" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done',
            '    kill -0 "$1" 2>/dev/null && kill -KILL "$1" 2>/dev/null',
            'fi',
            'rm -f "$STATE/jupyter.port"',
            'echo TOS_JUPYTER_STOPPED',
            ''
        );
    } else if (action === 'start') {
        const workspace = shellQuote(options.remoteWorkspace);
        lines.push(
            'if [ -n "$INFO" ]; then echo "TOS_JUPYTER_RUNNING $INFO"; exit 0; fi',
            `"$PY" -c 'import jupyter_server, ipykernel' 2>/dev/null || { echo TOS_JUPYTER_MISSING; exit 1; }`,
            `cd ${workspace} || { echo "TOS_JUPYTER_FAILED workspace"; exit 1; }`,
            `PORT=$("$PY" -c ${shellQuote(FREE_PORT_PY)})`,
            '[ -n "$PORT" ] || { echo "TOS_JUPYTER_FAILED port"; exit 1; }',
            'echo "$PORT" > "$STATE/jupyter.port"',
            `JUPYTER_TOKEN=${shellQuote(options.token)}`,
            'export JUPYTER_TOKEN',
            'LOG="$STATE/jupyter.log"',
            `set -- "$PY" -m jupyter_server --no-browser --ServerApp.ip=127.0.0.1 --ServerApp.port="$PORT" --ServerApp.port_retries=0 --ServerApp.root_dir=${workspace} `
                + `--ServerApp.terminals_enabled=False --ServerApp.shutdown_no_activity_timeout=${JUPYTER_IDLE_SECONDS} `
                + `--MappingKernelManager.cull_idle_timeout=${JUPYTER_IDLE_SECONDS} --MappingKernelManager.cull_interval=300`,
            // ssh 연결이 끝나도 서버가 남도록 새 세션으로 분리한다
            'if command -v setsid >/dev/null 2>&1; then setsid "$@" </dev/null >"$LOG" 2>&1 & else nohup "$@" </dev/null >"$LOG" 2>&1 & fi',
            'P=$!',
            'unset JUPYTER_TOKEN',
            'i=0',
            'while [ $i -lt 600 ]; do',
            '    INFO=$(find_server)',
            '    if [ -n "$INFO" ]; then echo "TOS_JUPYTER_STARTED $INFO"; exit 0; fi',
            '    kill -0 "$P" 2>/dev/null || break',
            '    sleep 0.2; i=$((i+1))',
            'done',
            'kill "$P" 2>/dev/null',
            'rm -f "$STATE/jupyter.port"',
            'echo TOS_JUPYTER_FAILED',
            'tail -n 20 "$LOG" 2>/dev/null',
            'exit 1',
            ''
        );
    }
    return lines.join('\n');
}

/**
 * @returns {{state: 'running'|'started'|'stopped'|'missing'|'failed'|'unknown', pid?: number, port?: number, token?: string, message?: string}}
 */
function parseJupyterOutput(stdout) {
    const lines = String(stdout || '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const running = /^TOS_JUPYTER_(RUNNING|STARTED) (\d+) (\d+) (\S*)$/.exec(line);
        if (running) {
            return { state: running[1] === 'RUNNING' ? 'running' : 'started', pid: Number(running[2]), port: Number(running[3]), token: running[4] };
        }
        if (line === 'TOS_JUPYTER_STOPPED') {
            return { state: 'stopped' };
        }
        if (line === 'TOS_JUPYTER_MISSING') {
            return { state: 'missing' };
        }
        const failed = /^TOS_JUPYTER_FAILED ?(.*)$/.exec(line);
        if (failed) {
            const detail = lines.slice(i + 1).map((l) => l.trim()).filter(Boolean);
            return { state: 'failed', message: [failed[1], ...detail.slice(-5)].filter(Boolean).join('\n') };
        }
    }
    return { state: 'unknown' };
}

// 로그·알림에 비밀번호가 섞이지 않도록 가린다 (너무 짧은 값은 일반 글자와 겹치므로 제외)
function maskSecrets(text, secrets) {
    let result = String(text);
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {
            result = result.split(secret).join('***');
        }
    }
    return result;
}

// Jupyter 로그·오류에 보이는 토큰(URL의 token=…)을 가린다
function maskToken(text, token) {
    const result = String(text).replace(/([?&]token=)[0-9A-Za-z]+/g, '$1***');
    return maskSecrets(result, [token]);
}

module.exports = {
    RUN_DEBUG_PATH,
    RUN_DEBUG_SCRIPT,
    GROUP_PACKAGES,
    CONSTRAINTS,
    MARK,
    TOOLS_PROBE_PY,
    MKTEMP_COMMAND,
    JUPYTER_IDLE_SECONDS,
    buildProbeCommand,
    parseProbeOutput,
    toolStatus,
    resolveTarget,
    normalizeName,
    preferenceLines,
    isInstalled,
    planInstall,
    buildRootInstallScript,
    buildInstallScript,
    buildSudoCheckScript,
    parseSudoCheck,
    parseInstallExit,
    parseTempDir,
    buildJupyterScript,
    parseJupyterOutput,
    maskSecrets,
    maskToken
};
