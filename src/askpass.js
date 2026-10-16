'use strict';

// SSH 비밀번호 인증을 화면 없이 처리한다 (SSH_ASKPASS).
// OpenSSH가 실행하는 askpass 스크립트가 VS Code의 Node.js로 askpassHelper.js를 돌리고,
// 도우미는 확장이 연 일회용 named pipe에 토큰을 보내 비밀번호를 받는다.
// 비밀번호는 명령줄·환경 변수·파일에 남기지 않는다 (환경 변수에는 파이프 이름과 일회용 토큰만 둔다).
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { writeIfChanged, noopLogger } = require('./util');

const PIPE_PREFIX = '\\\\.\\pipe\\tos-remote-askpass-';
const SESSION_TIMEOUT_MS = 120000;
const MAX_ANSWERS = 2;

/**
 * askpass.cmd 내용. cmd는 배치 파일을 OEM 코드 페이지로 읽으므로 사용자 이름이 들어가는 경로를 넣지 않는다(ASCII만).
 * 실행 파일과 도우미 경로는 환경 변수로 받아 cmd 특수 문자를 다시 해석하지 않는다.
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

function buildAskpassSh() {
    return [
        '#!/bin/sh',
        'ELECTRON_RUN_AS_NODE=1 exec "$TOS_ASKPASS_NODE" "$TOS_ASKPASS_HELPER"',
        ''
    ].join('\n');
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
        return path.join(this.storageDir, process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
    }

    /**
     * 비밀번호 하나를 제공하는 askpass 세션을 연다. ssh 프로세스 환경에 env를 더하고, 끝나면 dispose를 호출한다.
     * @returns {Promise<{env: Record<string, string>, dispose: () => void}>}
     */
    async open(secret) {
        const windows = process.platform === 'win32';
        writeIfChanged(this.scriptPath, windows ? buildAskpassCmd() : buildAskpassSh());
        if (!windows) {
            fs.chmodSync(this.scriptPath, 0o700);
        }
        const token = crypto.randomBytes(24).toString('hex');
        const pipe = windows ? `${PIPE_PREFIX}${crypto.randomBytes(12).toString('hex')}` : undefined;
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
            if (windows) {
                server.listen(pipe, resolve);
            } else {
                server.listen(0, '127.0.0.1', resolve);
            }
        });
        const address = server.address();
        let closed = false;
        const dispose = () => {
            if (!closed) {
                closed = true;
                clearTimeout(timer);
                server.close();
            }
        };
        const timer = setTimeout(dispose, SESSION_TIMEOUT_MS);
        const env = {
            SSH_ASKPASS: this.scriptPath,
            SSH_ASKPASS_REQUIRE: 'force',
            DISPLAY: process.env.DISPLAY || 'localhost:0',
            TOS_ASKPASS_NODE: this.nodeExecutable,
            TOS_ASKPASS_HELPER: this.helperScript,
            TOS_ASKPASS_TOKEN: token
        };
        if (windows) {
            env.TOS_ASKPASS_PIPE = pipe;
        } else {
            env.TOS_ASKPASS_HOST = address.address;
            env.TOS_ASKPASS_PORT = String(address.port);
        }
        return {
            env,
            dispose
        };
    }
}

module.exports = { AskpassBroker, buildAskpassCmd, buildAskpassSh };
