'use strict';

// Jupyter 확장 커널 컨트롤러 ID 규칙 (ms-toolsai.jupyter 2025.x에서 확인).
// 노트북용 컨트롤러 ID는 커널 연결 ID 그대로이고, Interactive 창용은 뒤에 " (Interactive)"가 붙는다.
const INTERACTIVE_SUFFIX = ' (Interactive)';
const INTERACTIVE_NOTEBOOK_TYPE = 'interactive';
const KERNEL_NOTEBOOK_TYPES = new Set(['jupyter-notebook', INTERACTIVE_NOTEBOOK_TYPE]);

/** 컨트롤러 ID → 문서 종류와 관계없는 커널 연결 ID */
function baseControllerId(controllerId) {
    const id = String(controllerId || '');
    return id.endsWith(INTERACTIVE_SUFFIX) ? id.slice(0, -INTERACTIVE_SUFFIX.length) : id;
}

/** 커널 연결 ID → 해당 문서 종류의 컨트롤러 ID */
function controllerIdFor(baseId, notebookType) {
    return notebookType === INTERACTIVE_NOTEBOOK_TYPE ? `${baseId}${INTERACTIVE_SUFFIX}` : baseId;
}

/** 보드별로 기억할 키 (같은 보드라도 계정·포트가 다르면 커널 경로가 다를 수 있다) */
function boardKey(session) {
    return session ? `${session.user}@${session.host}:${session.port}` : undefined;
}

module.exports = { baseControllerId, controllerIdFor, boardKey, KERNEL_NOTEBOOK_TYPES, INTERACTIVE_SUFFIX };
