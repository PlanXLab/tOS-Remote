'use strict';

// rclone의 `obscure`/`reveal`과 호환되는 구현 (AES-256-CTR, 공개된 고정 키).
// 암호화가 아니라 설정 파일·환경 변수에 평문이 보이지 않게 하는 용도다.
const crypto = require('crypto');
const { t } = require('./i18n');

const KEY = Buffer.from([
    0x9c, 0x93, 0x5b, 0x48, 0x73, 0x0a, 0x55, 0x4d,
    0x6b, 0xfd, 0x7c, 0x63, 0xc8, 0x86, 0xa9, 0x2b,
    0xd3, 0x90, 0x19, 0x8e, 0xb8, 0x12, 0x8a, 0xfb,
    0xf4, 0xde, 0x16, 0x2b, 0x8b, 0x95, 0xf6, 0x38
]);

function obscure(plain) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', KEY, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(String(plain), 'utf8')), cipher.final()]);
    return Buffer.concat([iv, encrypted]).toString('base64url');
}

function reveal(text) {
    const buffer = Buffer.from(String(text), 'base64url');
    if (buffer.length < 16) {
        throw new Error(t('Invalid obscured string.'));
    }
    const decipher = crypto.createDecipheriv('aes-256-ctr', KEY, buffer.subarray(0, 16));
    return Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString('utf8');
}

module.exports = { obscure, reveal };
