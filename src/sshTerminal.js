'use strict';

const path = require('path');
const { shellQuote } = require('./util');
const { t } = require('./i18n');

// VS Code 터미널에서 실행할 SSH 스크립트를 만든다.
// - 세션이 정상 종료되면 원격 셸의 종료 코드와 관계없이 0으로 끝내 "terminated with exit code" 알림이 뜨지 않게 한다.
// - ssh가 255(연결 단계 실패 등)로 끝나면 잠시 후 다시 시도하고, 최종 실패 시 원인을 남기고 키 입력을 기다린다.
// Windows는 cmd 배치 파일, Linux/macOS는 POSIX 셸 스크립트를 사용한다.

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_SECONDS = 2;
const POSIX_ATTEMPT_TOKEN = '__TOS_ATTEMPT__';

const WAIT_FOR_KEY = [
    'if [ -t 0 ]; then',
    '    saved_tty=$(stty -g)',
    '    trap \'stty "$saved_tty"\' 0',
    '    trap \'exit 0\' 1 2 15',
    '    stty -icanon -echo min 1 time 0',
    '    dd bs=1 count=1 >/dev/null 2>&1',
    '    stty "$saved_tty"',
    '    trap - 0 1 2 15',
    'fi'
];

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

function buildPosixSshTerminalScript(sshPath, sshArgs) {
    const commandLine = [sshPath, ...sshArgs].map(shellQuote).join(' ');
    const retryParts = t('Could not connect to the board. Retrying in {0} seconds ({1}/{2})',
        RETRY_DELAY_SECONDS, POSIX_ATTEMPT_TOKEN, MAX_ATTEMPTS).split(POSIX_ATTEMPT_TOKEN);
    const failedMessage = shellQuote(`[tOS] ${t('Could not connect to the board over SSH ({0} attempts). Check the board power and network.', MAX_ATTEMPTS)}`);
    const retryLine = `${shellQuote(`[tOS] ${retryParts[0]}`)}"$attempt"${shellQuote(retryParts[1])}`;
    return [
        '#!/bin/sh',
        'attempt=0',
        'while :; do',
        '    attempt=$((attempt + 1))',
        `    ${commandLine}`,
        '    status=$?',
        '    if [ "$status" -ne 255 ]; then',
        '        exit 0',
        '    fi',
        `    if [ "$attempt" -ge ${MAX_ATTEMPTS} ]; then`,
        `        printf '%s\\n' ${failedMessage}`,
        `        printf '%s' ${shellQuote(t('Press any key to close the terminal.'))}`,
        ...WAIT_FOR_KEY.map((line) => `        ${line}`),
        '        exit 0',
        '    fi',
        `    printf '%s\\n' ${retryLine}`,
        `    sleep ${RETRY_DELAY_SECONDS}`,
        'done',
        ''
    ].join('\n');
}

/**
 * @param {string} sshPath ssh 실행 파일 경로
 * @param {string[]} sshArgs ssh 인자 (원격 명령 포함)
 * @param {string} [platform] 실행할 플랫폼
 * @returns {string} 셸 스크립트 내용
 */
function buildSshTerminalScript(sshPath, sshArgs, platform = process.platform) {
    if (platform !== 'win32') {
        return buildPosixSshTerminalScript(sshPath, sshArgs);
    }
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

/**
 * "tOS에서 실행" 작업용 배치 파일 (내용이 고정되어 사용자 경로·파일 이름이 들어가지 않는다).
 * - ssh 경로와 인자는 환경 변수 TOS_SSH_EXE, TOS_SSH_ARGS로 받아 지연 확장(!VAR!)으로 실행한다.
 *   확장된 값은 배치 구문으로 다시 해석되지 않으므로 & % ^ ! " 같은 문자가 그대로 전달된다.
 * - 실행 완료를 터미널에 표시하고 키 입력을 기다려 사용자가 종료를 확인할 수 있게 한다.
 * - 프로그램이 다시 실행되지 않도록 재시도하지 않는다.
 */
function buildPosixRunScript(sshPath, sshArgs) {
    const commandLine = [sshPath, ...sshArgs].map(shellQuote).join(' ');
    return [
        '#!/bin/sh',
        commandLine,
        'status=$?',
        'if [ "$status" -eq 255 ]; then',
        `    printf '%s\\n' ${shellQuote(`[tOS] ${t('The connection to the board failed or was lost (ssh exit code 255).')}`)}`,
        `    printf '%s' ${shellQuote(t('Press any key to close the terminal.'))}`,
        'else',
        `    printf '%s\\n' ${shellQuote(`[tOS] ${t('Terminated, press any key to close the terminal.')}`)}`,
        'fi',
        ...WAIT_FOR_KEY,
        'exit 0',
        ''
    ].join('\n');
}

function buildRunScript(sshPath, sshArgs, platform = process.platform) {
    if (platform !== 'win32') {
        return buildPosixRunScript(sshPath, sshArgs);
    }
    return [
        '@echo off',
        'chcp 65001 >nul',
        'setlocal EnableDelayedExpansion',
        '!TOS_SSH_EXE! !TOS_SSH_ARGS!',
        'endlocal & set TOS_EXIT=%errorlevel%',
        'if not "%TOS_EXIT%"=="255" goto terminated',
        'echo.',
        echoLine(`[tOS] ${t('The connection to the board failed or was lost (ssh exit code 255).')}`),
        'goto done',
        ':terminated',
        'echo.',
        echoLine(`[tOS] ${t('Terminated, press any key to close the terminal.')}`),
        'pause >nul',
        ':done',
        'exit /b 0',
        ''
    ].join('\r\n');
}

function terminalScriptPath(storageDir, name, platform = process.platform) {
    return path.join(storageDir, `${name}${platform === 'win32' ? '.cmd' : '.sh'}`);
}

function terminalShellLaunch(scriptPath, platform = process.platform) {
    if (platform === 'win32') {
        return {
            shellPath: process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
            shellArgs: ['/d', '/c', scriptPath]
        };
    }
    return { shellPath: '/bin/sh', shellArgs: [scriptPath] };
}

/** Windows 실행 배치 파일에 넘길 환경 변수 */
function runScriptEnv(sshPath, sshArgs) {
    return {
        TOS_SSH_EXE: quoteWindowsArg(sshPath),
        TOS_SSH_ARGS: sshArgs.map(quoteWindowsArg).join(' ')
    };
}

module.exports = {
    buildSshTerminalScript, buildRunScript, runScriptEnv, quoteWindowsArg, echoLine,
    terminalScriptPath, terminalShellLaunch
};
