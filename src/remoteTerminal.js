'use strict';

// 원격 작업 공간 창이 열릴 때 VS Code가 이전 터미널 기록으로 복원하거나 자동으로 만든
// 로컬 셸 터미널을 보드 SSH 터미널로 바꾼다. 창이 열린 직후에만 동작하며,
// 그 뒤 사용자가 직접 연 로컬 터미널은 건드리지 않는다.
const path = require('path');
const { TERMINAL_PROFILE } = require('./workspaceFile');

let vscode;
try {
    vscode = require('vscode');
} catch {
    vscode = undefined;
}

const GRACE_MS = 10000;

function normalizePath(value) {
    return path.normalize(String(value).replace(/^"|"$/g, '')).toLowerCase();
}

/**
 * @param {{name: string, creationOptions?: any}} terminal
 * @param {string} scriptPath ssh-terminal.cmd 경로
 * @param {string[]} [excludedNamePrefixes] 작업(Run on tOS) 터미널 이름 접두사
 * @returns {boolean} 로컬 셸 터미널이면 true
 */
function isLocalShellTerminal(terminal, scriptPath, excludedNamePrefixes = []) {
    const options = terminal.creationOptions || {};
    // 확장 터미널(pty), 숨김 터미널, 이 확장의 SSH 터미널, 작업 터미널은 제외
    if ('pty' in options || options.hideFromUser) {
        return false;
    }
    const name = String(terminal.name || '');
    if (name === TERMINAL_PROFILE || excludedNamePrefixes.some((prefix) => prefix && name.startsWith(prefix))) {
        return false;
    }
    const args = Array.isArray(options.shellArgs) ? options.shellArgs
        : (typeof options.shellArgs === 'string' ? [options.shellArgs] : []);
    if (scriptPath && args.some((arg) => normalizePath(arg) === normalizePath(scriptPath))) {
        return false;
    }
    return true;
}

class RemoteTerminalGuard {
    /**
     * @param {{log?: any, excludedNamePrefixes?: string[], graceMs?: number}} options
     */
    constructor(options = {}) {
        this.log = options.log;
        this.excludedNamePrefixes = options.excludedNamePrefixes || [];
        this.graceMs = options.graceMs === undefined ? GRACE_MS : options.graceMs;
        this.pending = new Set();
        this.launch = undefined;
        this.disposables = [];
        this.graceTimer = undefined;
    }

    /** 세션 준비 전부터 열려 있거나 새로 열리는 터미널을 모은다. */
    begin() {
        this.stop();
        this.pending = new Set(vscode.window.terminals);
        this.disposables.push(
            vscode.window.onDidOpenTerminal((terminal) => {
                if (this.launch) {
                    this.replace([terminal]);
                } else {
                    this.pending.add(terminal);
                }
            }),
            vscode.window.onDidCloseTerminal((terminal) => this.pending.delete(terminal))
        );
    }

    /**
     * 세션이 준비되면 모아 둔 로컬 터미널을 바꾸고, 잠시 동안 늦게 열리는 터미널도 바꾼다.
     * @param {{shellPath: string, shellArgs: string[], scriptPath: string}} launch
     */
    activate(launch) {
        this.launch = launch;
        const terminals = Array.from(this.pending);
        this.pending.clear();
        this.replace(terminals);
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => this.stop(), this.graceMs);
    }

    replace(terminals) {
        const launch = this.launch;
        const local = terminals.filter((terminal) => terminal.exitStatus === undefined
            && isLocalShellTerminal(terminal, launch.scriptPath, this.excludedNamePrefixes));
        if (!local.length) {
            return;
        }
        const active = vscode.window.activeTerminal;
        // 보드 연결 수를 늘리지 않도록 원격 터미널이 이미 있으면 그것을 쓰고, 없으면 하나만 만든다
        let remote = vscode.window.terminals.find((terminal) => terminal.exitStatus === undefined
            && !local.includes(terminal) && !isLocalShellTerminal(terminal, launch.scriptPath)
            && terminal.name === TERMINAL_PROFILE);
        if (!remote) {
            remote = vscode.window.createTerminal({
                name: TERMINAL_PROFILE,
                shellPath: launch.shellPath,
                shellArgs: launch.shellArgs,
                iconPath: new vscode.ThemeIcon('remote')
            });
        }
        if (!active || local.includes(active)) {
            remote.show(true);
        }
        for (const terminal of local) {
            terminal.dispose();
        }
        if (this.log) {
            this.log.info(`Replaced ${local.length} local terminal(s) with the tOS SSH terminal: ${local.map((t) => t.name).join(', ')}`);
        }
    }

    stop() {
        clearTimeout(this.graceTimer);
        this.graceTimer = undefined;
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];
        this.pending.clear();
        this.launch = undefined;
    }

    dispose() {
        this.stop();
    }
}

module.exports = { RemoteTerminalGuard, isLocalShellTerminal };
