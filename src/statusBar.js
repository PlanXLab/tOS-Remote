'use strict';

const path = require('path');
const vscode = require('vscode');
const { t } = require('./i18n');

function phases() {
    return {
        idle: { icon: '$(remote)', text: 'tOS', tooltip: t('The remote workspace is closed. Click to open the menu.') },
        opening: { icon: '$(sync~spin)', text: t('tOS: Opening'), tooltip: t('Opening the remote workspace.') },
        reconnecting: { icon: '$(sync~spin)', text: t('tOS: Reconnecting'), tooltip: t('Restoring the connection to the board.'), warning: true },
        closing: { icon: '$(sync~spin)', text: t('tOS: Closing'), tooltip: t('Closing the remote workspace.') },
        open: { icon: '$(remote)', text: 'tOS', tooltip: t('The remote workspace is open.'), active: true },
        elsewhere: { icon: '$(remote)', text: t('tOS: Other Window'), tooltip: t('The remote workspace is open in another window.') },
        detached: { icon: '$(remote)', text: t('tOS: Detached'), tooltip: t('The remote workspace window is closed.') }
    };
}

class StatusBar {
    constructor() {
        this.item = vscode.window.createStatusBarItem('tosRemote.status', vscode.StatusBarAlignment.Left, 1000);
        this.item.name = 'tOS Remote';
        this.item.command = 'tosRemote.showMenu';
        this.phases = phases();
        this.jupyter = 'stopped';
        this.status = { phase: 'idle' };
        this.item.show();
        this.update({ phase: 'idle' });
    }

    /** 보드 Jupyter 서버 상태 (실행 중이면 노트북 아이콘 표시) */
    setJupyter(phase) {
        this.jupyter = phase || 'stopped';
        this.update(this.status);
    }

    update(status) {
        this.status = status;
        const phase = this.phases[status.phase] || this.phases.idle;
        const session = status.session;
        let text = phase.text;
        if (status.phase === 'open' && session) {
            const loc = session.localWorkspace ? path.basename(session.localWorkspace) : (session.drive || '');
            text = `tOS: ${loc} ${session.host}`;
        }
        if (status.pendingUploads > 0) {
            text += ` $(cloud-upload) ${status.pendingUploads}`;
        }
        if (status.phase === 'open' && this.jupyter !== 'stopped') {
            text += this.jupyter === 'running' ? ' $(notebook)' : ' $(sync~spin)';
        }
        this.item.text = `${phase.icon} ${text}`;
        const loc = session ? (session.localWorkspace || session.drive || '') : '';
        const details = session ? `\n\n${session.user}@${session.host}\n${session.remoteWorkspace} → ${loc}` : '';
        const jupyter = status.phase === 'open' && this.jupyter === 'running' ? `\n${t('Jupyter: running on the board')}` : '';
        this.item.tooltip = `${phase.tooltip}${details}${jupyter}`;
        this.item.backgroundColor = phase.warning
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : phase.active ? new vscode.ThemeColor('statusBarItem.remoteBackground') : undefined;
        this.item.color = phase.active ? new vscode.ThemeColor('statusBarItem.remoteForeground') : undefined;
    }

    dispose() {
        this.item.dispose();
    }
}

module.exports = { StatusBar };
