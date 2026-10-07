'use strict';

// VS Code 터미널에서 cmd.exe로 실행할 SSH 터미널 배치 파일을 만든다.
// - 세션이 정상 종료되면 원격 셸의 종료 코드와 관계없이 0으로 끝내 "terminated with exit code" 알림이 뜨지 않게 한다.
// - ssh가 255(연결 단계 실패 등)로 끝나면 잠시 후 다시 시도하고, 최종 실패 시 원인을 남기고 키 입력을 기다린다.
// cmd.exe는 콘솔 프로그램이라 ConPTY에 연결되며, 자식 ssh.exe가 같은 콘솔을 그대로 사용한다.
// (VS Code의 Code.exe는 GUI 프로그램이라 ConPTY에 연결되지 않아 래퍼로 쓸 수 없다)
const { t } = require('./i18n');

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 2;

// Windows C 런타임 규칙에 맞춘 명령줄 인자 인용 (libuv quote_cmd_arg와 같은 방식)
function quoteWindowsArg(arg) {
    const text = String(arg);
    if (text && !/[\s"]/.test(text)) {
        return text;
    }
    let result = '"';
    let backslashes = 0;
    for (const ch of text) {
        if (ch === '\\') {
            backslashes++;
        } else if (ch === '"') {
            result += '\\'.repeat(backslashes * 2 + 1) + '"';
            backslashes = 0;
        } else {
            result += '\\'.repeat(backslashes) + ch;
            backslashes = 0;
        }
    }
    return `${result}${'\\'.repeat(backslashes * 2)}"`;
}

// cmd echo용 이스케이프 (번역문에 특수 문자가 있어도 안전하도록). ATTEMPT_TOKEN은 배치 변수로 바꾼다.
const ATTEMPT_TOKEN = '\u0000ATTEMPT\u0000';

function echoLine(text) {
    const escaped = String(text).replace(/[\r\n]+/g, ' ').replace(/%/g, '%%').replace(/([\^&|<>])/g, '^$1');
    return `echo ${escaped.split(ATTEMPT_TOKEN).join('%TOS_ATTEMPT%')}`;
}

/**
 * @param {string} sshPath ssh.exe 경로
 * @param {string[]} sshArgs ssh 인자 (원격 명령 포함)
 * @returns {string} 배치 파일 내용 (CRLF, UTF-8)
 */
function buildSshTerminalScript(sshPath, sshArgs) {
    const commandLine = [sshPath, ...sshArgs].map(quoteWindowsArg).join(' ');
    // cmd 특수 문자가 인용 밖으로 노출되지 않도록 방어 (ssh 인자에는 원래 포함되지 않는다)
    if (/[&|<>^\r\n]/.test(commandLine)) {
        throw new Error(t('The SSH terminal command contains unsupported characters: {0}', commandLine));
    }
    return [
        '@echo off',
        'chcp 65001 >nul',
        'set TOS_ATTEMPT=0',
        ':retry',
        'set /a TOS_ATTEMPT+=1',
        commandLine.replace(/%/g, '%%'),
        'if not errorlevel 255 exit /b 0',
        `if %TOS_ATTEMPT% geq ${MAX_ATTEMPTS} goto fail`,
        'echo.',
        echoLine(`[tOS] ${t('Could not connect to the board. Retrying in {0} seconds ({1}/{2})', RETRY_DELAY_SECONDS, ATTEMPT_TOKEN, MAX_ATTEMPTS)}`),
        `timeout /t ${RETRY_DELAY_SECONDS} /nobreak >nul`,
        'goto retry',
        ':fail',
        'echo.',
        echoLine(`[tOS] ${t('Could not connect to the board over SSH ({0} attempts). Check the board power and network.', MAX_ATTEMPTS)}`),
        echoLine(t('Press any key to close the terminal.')),
        'pause >nul',
        'exit /b 0',
        ''
    ].join('\r\n');
}

module.exports = { buildSshTerminalScript, quoteWindowsArg, echoLine };
