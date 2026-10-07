'use strict';

const { shellQuote } = require('./util');

const DEBUG_READY = 'TOS_DEBUG_READY';
const DEBUG_FAILED = 'TOS_DEBUG_FAILED';

/** 보드에서 debugpy를 실행하고 포트가 열릴 때까지 기다리는 POSIX sh 스크립트 (ssh 'sh -s'의 stdin으로 전달) */
function buildDebugScript({ remoteWorkspace, pythonCommand, relativePath, port }) {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
    return [
        `cd ${shellQuote(remoteWorkspace)} || { echo ${DEBUG_FAILED}; exit 1; }`,
        // 스크립트는 stdin으로 전달되므로 이 셸의 명령줄에는 debugpy가 없어 자기 자신은 종료되지 않는다
        'pkill -u "$(id -u)" -f debugpy 2>/dev/null',
        `listening() { grep -qiE ":${hexPort} [0-9A-F]+:0000 0A" /proc/net/tcp /proc/net/tcp6 2>/dev/null; }`,
        'i=0; while listening && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done',
        `${pythonCommand} -u -Xfrozen_modules=off -m debugpy --listen 0.0.0.0:${port} --wait-for-client ${shellQuote(relativePath)} &`,
        'P=$!',
        'i=0',
        'while [ $i -lt 200 ]; do',
        `    if listening; then echo ${DEBUG_READY}; break; fi`,
        '    kill -0 $P 2>/dev/null || break',
        '    sleep 0.1; i=$((i+1))',
        'done',
        `kill -0 $P 2>/dev/null || echo ${DEBUG_FAILED}`,
        'wait $P',
        ''
    ].join('\n');
}

module.exports = { buildDebugScript, DEBUG_READY, DEBUG_FAILED };
