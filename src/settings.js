'use strict';

const vscode = require('vscode');
const { normalizeRemotePath, normalizeDriveLetter } = require('./util');
const { expandHome } = require('./ssh');
const { t } = require('./i18n');

const SECTION = 'tosRemote';

// 사이드바 패널에서 편집 가능한 항목
const EDITABLE_KEYS = ['host', 'port', 'user', 'remoteWorkspace', 'driveLetter'];

function getSettings() {
    const config = vscode.workspace.getConfiguration(SECTION);
    const user = String(config.get('user') || '').trim();
    return {
        host: String(config.get('host') || '').trim(),
        port: Number(config.get('port')) || 22,
        user,
        remoteWorkspace: normalizeRemotePath(config.get('remoteWorkspace'), user ? `/home/${user}/Workspace` : '/'),
        driveLetter: normalizeDriveLetter(config.get('driveLetter')),
        identityFile: expandHome(config.get('identityFile')),
        pythonCommand: String(config.get('pythonCommand') || 'python3').trim() || 'python3',
        debugPort: Number(config.get('debugPort')) || 5678,
        pythonLibraryPaths: (config.get('pythonLibraryPaths') || []).map((p) => normalizeRemotePath(p)).filter((p) => p !== '/'),
        pathMappings: config.get('pathMappings') || [],
        rclonePath: expandHome(config.get('rclonePath'))
    };
}

function validateSettings(settings) {
    if (!settings.host) {
        return t('Enter the board host (tosRemote.host).');
    }
    if (!settings.user) {
        return t('Enter the user account (tosRemote.user).');
    }
    if (settings.remoteWorkspace === '/') {
        return t('The root directory (/) cannot be used as the remote workspace.');
    }
    return undefined;
}

function targetOf(settings) {
    return { host: settings.host, port: settings.port, user: settings.user };
}

async function updateSetting(key, value) {
    if (!EDITABLE_KEYS.includes(key)) {
        throw new Error(t('This setting cannot be edited: {0}', key));
    }
    let normalized = value;
    if (key === 'port') {
        normalized = Number(value);
        if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65535) {
            throw new Error(t('The port must be a number from 1 to 65535.'));
        }
    } else if (key === 'driveLetter') {
        normalized = value ? normalizeDriveLetter(value) : '';
        if (value && !normalized) {
            throw new Error(t('The drive letter must be one of D to Z.'));
        }
    } else if (key === 'remoteWorkspace') {
        normalized = normalizeRemotePath(value);
    } else {
        normalized = String(value || '').trim();
    }
    await vscode.workspace.getConfiguration(SECTION).update(key, normalized, vscode.ConfigurationTarget.Global);
}

module.exports = { SECTION, EDITABLE_KEYS, getSettings, validateSettings, targetOf, updateSetting };
