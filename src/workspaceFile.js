'use strict';

const { shellQuote } = require('./util');
const { t } = require('./i18n');

const TERMINAL_PROFILE = 'tOS SSH';

/** SSH 터미널용 ssh 인자 (원격 명령은 cmd 배치 파일에서도 안전하도록 &, |, <, >, " 없이 구성) */
function sshTerminalArgs(sshArgs, target, remoteWorkspace) {
    return [...sshArgs, '-t', `${target.user}@${target.host}`, `cd ${shellQuote(remoteWorkspace)}; exec $SHELL -l`];
}

/**
 * 원격 작업 공간용 .code-workspace 내용을 만든다. (PC 로컬 확장 저장소에 저장되며 보드에는 쓰지 않는다)
 * @param {{drive: string, target: {host: string, port: number, user: string}, remoteWorkspace: string,
 *          sshPath: string, sshArgs: string[], libraryCachePaths: string[],
 *          terminal?: {path: string, args: string[]}}} options
 *        terminal을 지정하면 ssh.exe를 직접 실행하지 않고 지정한 실행 파일(SSH 터미널 배치 파일 등)로 실행한다.
 */
function buildWorkspace(options) {
    const { drive, target, remoteWorkspace, sshPath, sshArgs, libraryCachePaths, terminal } = options;
    const destination = `${target.user}@${target.host}`;
    const profile = terminal
        ? { path: terminal.path, args: terminal.args }
        : { path: sshPath, args: sshTerminalArgs(sshArgs, target, remoteWorkspace) };

    return {
        folders: [
            {
                name: `tOS · ${destination}:${remoteWorkspace}`,
                path: `${drive}/`
            }
        ],
        settings: {
            'files.eol': '\n',
            'files.watcherExclude': {
                '**/.git/objects/**': true,
                '**/.venv/**': true,
                '**/__pycache__/**': true
            },
            'search.exclude': {
                '**/.venv': true,
                '**/__pycache__': true
            },
            'search.followSymlinks': false,
            'python.analysis.extraPaths': libraryCachePaths.map((p) => p.replace(/\\/g, '/')),
            'python.analysis.autoSearchPaths': true,
            'python.terminal.activateEnvironment': false,
            'terminal.integrated.enablePersistentSessions': false,
            'terminal.integrated.persistentSessionReviveProcess': 'never',
            'terminal.integrated.profiles.windows': {
                [TERMINAL_PROFILE]: {
                    ...profile,
                    icon: 'remote',
                    overrideName: true
                }
            },
            'terminal.integrated.defaultProfile.windows': TERMINAL_PROFILE
        },
        launch: {
            version: '0.2.0',
            configurations: [
                {
                    name: t('tOS: Current File'),
                    type: 'tos-remote',
                    request: 'launch',
                    program: '${file}',
                    justMyCode: true
                }
            ]
        },
        extensions: {
            recommendations: ['ms-python.python', 'ms-python.debugpy']
        }
    };
}

module.exports = { buildWorkspace, sshTerminalArgs, TERMINAL_PROFILE };
