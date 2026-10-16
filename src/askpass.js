'use strict';

// SSH 비밀번호 인증을 화면 없이 처리한다 (SSH_ASKPASS).
// ssh.exe가 실행하는 askpass.cmd가 Code.exe를 Node로 실행해 askpassHelper.js를 돌리고,
// 도우미는 확장이 연 일회용 named pipe에 토큰을 보내 비밀번호를 받는다.
// 비밀번호는 명령줄·환경 변수·파일에 남기지 않는다 (환경 변수에는 파이프 이름과 일회용 토큰만 둔다).
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { writeIfChanged, noopLogger } = require('./util');

const PIPE_PREFIX = '\\\\.\\pipe\\tos-remote-askpass-';
const SESSION_TIMEOUT_MS = 120000;
const MAX_ANSWERS = 2;

/**
 * askpass.cmd 내용. cmd는 배치 파일을 OEM 코드 페이지로 읽으므로 사용자 이름이 들어가는 경로를 넣지 않는다(ASCII만).
 * Code.exe와 도우미 경로는 환경 변수(유니코드)로 받는다. 확장된 값의 %는 다시 해석되지 않고 따옴표 안의 & ^는 그대로 쓰인다.
 */
function buildAskpassCmd() {
    return [
        '@echo off',
        'setlocal DisableDelayedExpansion',
        'set ELECTRON_RUN_AS_NODE=1',
        '"%TOS_ASKPASS_NODE%" "%TOS_ASKPASS_HELPER%"',
        ''
    ].join('\r\n');
}

function sameToken(a, b) {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class AskpassBroker {
    /**
     * @param {{storageDir: string, nodeExecutable: string, helperScript: string, logger?: object}} options
     */
    constructor(options) {
        this.storageDir = options.storageDir;
        this.nodeExecutable = options.nodeExecutable;
        this.helperScript = options.helperScript;
        this.logger = options.logger || noopLogger;
    }

    get scriptPath() {
        return path.join(this.storageDir, 'askpass.cmd');
    }

    /**
     * 비밀번호 하나를 제공하는 askpass 세션을 연다. ssh 프로세스 환경에 env를 더하고, 끝나면 dispose를 호출한다.
     * @returns {Promise<{env: Record<string, string>, dispose: () => void}>}
     */
    async open(secret) {
        writeIfChanged(this.scriptPath, buildAskpassCmd());
        const token = crypto.randomBytes(24).toString('hex');
        const pipe = `${PIPE_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
        let answers = 0;
        const server = net.createServer((socket) => {
            let data = '';
            socket.setEncoding('utf8');
            socket.on('data', (chunk) => {
                data += chunk;
                const newline = data.indexOf('\n');
                if (data.length > 512 || (newline >= 0 && (!sameToken(data.slice(0, newline), token) || answers >= MAX_ANSWERS))) {
                    socket.destroy();
                } else if (newline >= 0) {
                    answers++;
                    socket.end(String(secret));
                }
            });
            socket.on('error', () => {});
        });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(pipe, resolve);
        });
        let closed = false;
        const dispose = () => {
            if (!closed) {
                closed = true;
                clearTimeout(timer);
                server.close();
            }
        };
        const timer = setTimeout(dispose, SESSION_TIMEOUT_MS);
        return {
            env: {
                SSH_ASKPASS: this.scriptPath,
                // OpenSSH 8.4 이상
                SSH_ASKPASS_REQUIRE: 'force',
                // Windows 10 기본 OpenSSH(8.1)는 DISPLAY가 있어야 SSH_ASKPASS를 사용한다 (8.4 이상에서는 영향 없음)
                DISPLAY: process.env.DISPLAY || 'localhost:0',
                TOS_ASKPASS_NODE: this.nodeExecutable,
                TOS_ASKPASS_HELPER: this.helperScript,
                TOS_ASKPASS_PIPE: pipe,
                TOS_ASKPASS_TOKEN: token
            },
            dispose
        };
    }
}

module.exports = { AskpassBroker, buildAskpassCmd };
