'use strict';

// SSH_ASKPASS 도우미. askpass.cmd가 Code.exe(ELECTRON_RUN_AS_NODE=1)로 실행한다.
// 확장이 연 named pipe에 일회용 토큰을 보내고, 받은 비밀번호를 표준 출력으로 ssh에 넘긴다.
const net = require('net');

const pipe = process.env.TOS_ASKPASS_PIPE;
const token = process.env.TOS_ASKPASS_TOKEN;
if (!pipe || !token) {
    process.exit(1);
}

const chunks = [];
const socket = net.connect(pipe, () => socket.write(`${token}\n`));
socket.on('data', (chunk) => chunks.push(chunk));
socket.on('end', () => {
    const secret = Buffer.concat(chunks).toString('utf8');
    if (!secret) {
        process.exit(1);
    }
    process.stdout.write(`${secret}\n`);
});
socket.on('error', () => process.exit(1));
setTimeout(() => process.exit(1), 15000).unref();
