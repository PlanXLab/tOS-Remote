'use strict';

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
        detached: { icon: '$(remote)', text: t('tOS: Mounted'), tooltip: t('The drive is mounted, but no workspace window is open.') }
    };
}

class StatusBar {
    constructor() {
        this.item = vscode.window.createStatusBarItem('tosRemote.status', vscode.StatusBarAlignment.Left, 1000);
        this.item.name = 'tOS Remote';
        this.item.command = 'tosRemote.showMenu';
        this.phases = phases();
        this.item.show();
        this.update({ phase: 'idle' });
    }

    update(status) {
        const phase = this.phases[status.phase] || this.phases.idle;
        const session = status.session;
        let text = phase.text;
        if (status.phase === 'open' && session) {
            text = `tOS: ${session.drive} ${session.host}`;
        }
        if (status.pendingUploads > 0) {
            text += ` $(cloud-upload) ${status.pendingUploads}`;
        }
        this.item.text = `${phase.icon} ${text}`;
        const details = session ? `\n\n${session.user}@${session.host}\n${session.remoteWorkspace} → ${session.drive}` : '';
        this.item.tooltip = `${phase.tooltip}${details}`;
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
