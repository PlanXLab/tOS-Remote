'use strict';

// 경로에 포함될 수 있는 문자: 공백, 따옴표, 괄호, 콜론 등 출력 구분자는 제외
const PATH_CHARS = String.raw`[^\s"'\x60<>|:,;()\[\]{}]`;

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeRemote(remote) {
    const value = String(remote || '').trim().replace(/\/+$/, '');
    return value.startsWith('/') && value.length > 1 ? value : '';
}

/**
 * @param {{remote: string, local: string}[]} mappings 원격(리눅스) 경로 → 로컬 경로 매핑
 */
function createMatcher(mappings) {
    const list = (Array.isArray(mappings) ? mappings : [])
        .map((m) => ({ remote: normalizeRemote(m && m.remote), local: m && m.local }))
        .filter((m) => m.remote && typeof m.local === 'string' && m.local.trim())
        .sort((a, b) => b.remote.length - a.remote.length);

    if (list.length === 0) {
        return null;
    }

    const roots = list.map((m) => escapeRegExp(m.remote)).join('|');
    // 1) 따옴표 경로(공백 허용): Python traceback `File "...", line N`
    // 2) 일반 경로: gcc/warnings `path:N:M`, pdb `path(N)`
    const source = String.raw`"((?:${roots})(?:/[^"\r\n]*)?)"(?:, line (\d+))?` +
        String.raw`|(?<![\w.~/-])((?:${roots})(?:/${PATH_CHARS}*)?)(?!${PATH_CHARS})` +
        String.raw`(?::(\d+)(?::(\d+))?|\((\d+)\))?`;

    return { mappings: list, source };
}

function findLinks(matcher, line) {
    if (!matcher || !line) {
        return [];
    }

    const regex = new RegExp(matcher.source, 'g');
    const links = [];
    let match;

    while ((match = regex.exec(line)) !== null) {
        const quoted = match[1] !== undefined;
        let fullPath = quoted ? match[1] : match[3];
        // 따옴표 경로는 여는 따옴표 다음부터 링크로 표시
        const startIndex = quoted ? match.index + 1 : match.index;
        let length = quoted ? match[0].length - 1 : match[0].length;
        const lineNumber = Number(match[2] || match[4] || match[6]) || undefined;
        const column = Number(match[5]) || undefined;

        // 문장 끝 마침표 제거 (예: "saved to /home/tos/Workspace/out.png.")
        if (!quoted && !lineNumber) {
            const trimmed = fullPath.replace(/\.+$/, '');
            length -= fullPath.length - trimmed.length;
            fullPath = trimmed;
        }

        const mapping = matcher.mappings.find((m) => fullPath === m.remote || fullPath.startsWith(m.remote + '/'));
        if (!mapping) {
            continue;
        }

        links.push({
            startIndex,
            length,
            remotePath: fullPath,
            local: mapping.local,
            relative: fullPath.slice(mapping.remote.length).replace(/^\/+/, ''),
            line: lineNumber,
            column
        });
    }

    return links;
}

module.exports = { createMatcher, findLinks, normalizeRemote };
