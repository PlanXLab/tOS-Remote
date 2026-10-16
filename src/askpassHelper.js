'use strict';

// SSH_ASKPASS 도우미. 확장이 연 일회용 로컬 채널에서 비밀번호를 받아 표준 출력으로 ssh에 넘긴다.
const net = require('net');

const pipe = process.env.TOS_ASKPASS_PIPE;
const host = process.env.TOS_ASKPASS_HOST;
const port = Number(process.env.TOS_ASKPASS_PORT);
const token = process.env.TOS_ASKPASS_TOKEN;
const address = pipe || (host && Number.isInteger(port) && port > 0 ? { host, port } : undefined);
if (!address || !token) {
    process.exit(1);
}

const chunks = [];
const socket = net.connect(address, () => socket.write(`${token}\n`));
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
