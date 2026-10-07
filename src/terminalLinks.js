'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { createMatcher, findLinks } = require('./linkParser');
const { getSettings } = require('./settings');
const { t } = require('./i18n');

/** SSH 터미널에 출력된 보드 경로를 로컬(마운트/캐시) 경로로 바꿔 Ctrl+클릭으로 연다 */
class TerminalLinkProvider {
    constructor(sessionMgr) {
        this.sessionMgr = sessionMgr;
        this.cacheKey = undefined;
        this.matcher = undefined;
    }

    getMatcher() {
        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
        const extra = (getSettings().pathMappings || []).map((m) => ({
            remote: m && m.remote,
            local: m && typeof m.local === 'string' && workspaceFolder
                ? m.local.split('${workspaceFolder}').join(workspaceFolder.uri.fsPath)
                : m && m.local
        }));
        const mappings = [...this.sessionMgr.getPathMappings(), ...extra];
        const key = JSON.stringify(mappings);
        if (key !== this.cacheKey) {
            this.cacheKey = key;
            this.matcher = createMatcher(mappings);
        }
        return this.matcher;
    }

    provideTerminalLinks(context) {
        return findLinks(this.getMatcher(), context.line).map((link) => ({
            ...link,
            tooltip: link.line ? t('tOS: Open locally (line {0})', link.line) : t('tOS: Open locally')
        }));
    }

    async handleTerminalLink(link) {
        if (!link.local || link.local.includes('${')) {
            vscode.window.showWarningMessage(t('Cannot determine the local path: {0}', link.remotePath));
            return;
        }
        const target = link.relative ? path.join(link.local, ...link.relative.split('/')) : link.local;
        let stat;
        try {
            stat = await fs.promises.stat(target);
        } catch {
            vscode.window.showWarningMessage(t('File not found: {0}', target));
            return;
        }
        const uri = vscode.Uri.file(target);
        if (stat.isDirectory()) {
            await vscode.commands.executeCommand('revealInExplorer', uri);
            return;
        }
        const options = {};
        if (link.line) {
            const position = new vscode.Position(link.line - 1, Math.max((link.column || 1) - 1, 0));
            options.selection = new vscode.Range(position, position);
        }
        await vscode.commands.executeCommand('vscode.open', uri, options);
    }
}

module.exports = { TerminalLinkProvider };
