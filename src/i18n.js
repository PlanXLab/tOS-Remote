'use strict';

// 사용자에게 보이는 문자열 번역. 원문은 영어이며, VS Code 표시 언어가 한국어이면 l10n/bundle.l10n.ko.json을 사용한다.
// VS Code 밖(단위 테스트)에서는 영어 원문에 인자만 채워 반환한다.
let l10n;
try {
    l10n = require('vscode').l10n;
} catch {
    l10n = undefined;
}

function format(message, args) {
    return message.replace(/\{(\d+)\}/g, (match, index) => (args[index] === undefined ? match : String(args[index])));
}

/**
 * @param {string} message 영어 원문 (자리표시자 {0}, {1} ...)
 * @param {...(string|number|boolean)} args
 */
function t(message, ...args) {
    if (l10n) {
        return l10n.t(message, ...args);
    }
    return format(message, args);
}

module.exports = { t, format };
