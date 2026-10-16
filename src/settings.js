'use strict';

const vscode = require('vscode');
const { normalizeRemotePath, normalizeDriveLetter, homeDirOf, normalizeWorkspaceFolder, workspacePathOf } = require('./util');
const { expandHome } = require('./ssh');
const { t } = require('./i18n');

const SECTION = 'tosRemote';

// 사이드바 패널에서 편집 가능한 항목
const EDITABLE_KEYS = ['host', 'port', 'user', 'remoteWorkspace', 'driveLetter', 'localWorkspace'];

function getSettings() {
    const config = vscode.workspace.getConfiguration(SECTION);
    const user = String(config.get('user') || '').trim();
    // remoteWorkspace 설정은 홈(/home/<user>) 아래의 상대 경로다. 실제 경로는 계정으로 만든다.
    const workspace = normalizeWorkspaceFolder(config.get('remoteWorkspace'), user);
    return {
        host: String(config.get('host') || '').trim(),
        port: Number(config.get('port')) || 22,
        user,
        homeDir: homeDirOf(user),
        workspaceFolder: workspace.folder,
        workspaceError: workspace.error,
        remoteWorkspace: user && workspace.folder ? workspacePathOf(user, workspace.folder) : '',
        driveLetter: normalizeDriveLetter(config.get('driveLetter')),
        localWorkspace: expandHome(config.get('localWorkspace')),
        identityFile: expandHome(config.get('identityFile')),
        pythonCommand: String(config.get('pythonCommand') || 'python3').trim() || 'python3',
        debugPort: Number(config.get('debugPort')) || 5678,
        pythonLibraryPaths: (config.get('pythonLibraryPaths') || []).map((p) => normalizeRemotePath(p)).filter((p) => p !== '/'),
        pathMappings: config.get('pathMappings') || [],
        rclonePath: expandHome(config.get('rclonePath')),
        packageExcludeNewer: String(config.get('packageExcludeNewer') || '').trim()
    };
}

function workspaceErrorMessage(error, user) {
    const home = homeDirOf(user);
    switch (error) {
        case 'empty':
            return t('Enter the workspace folder under {0}/.', home);
        case 'outside':
            return t('The workspace must be inside the home directory {0}/.', home);
        case 'invalid':
            return t('The workspace folder cannot contain "." or ".." path segments.');
        default:
            return undefined;
    }
}

function validateSettings(settings) {
    if (!settings.host) {
        return t('Enter the board host (tosRemote.host).');
    }
    if (!settings.user) {
        return t('Enter the user account (tosRemote.user).');
    }
    if (settings.workspaceError) {
        return workspaceErrorMessage(settings.workspaceError, settings.user);
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
    } else if (key === 'localWorkspace') {
        normalized = String(value || '').trim();
    } else if (key === 'remoteWorkspace') {
        const user = getSettings().user;
        const workspace = normalizeWorkspaceFolder(value, user);
        if (workspace.error) {
            throw new Error(workspaceErrorMessage(workspace.error, user));
        }
        normalized = workspace.folder;
    } else {
        normalized = String(value || '').trim();
    }
    await vscode.workspace.getConfiguration(SECTION).update(key, normalized, vscode.ConfigurationTarget.Global);
}

/** 이전 형식의 절대 경로(/home/<user>/Workspace) 설정을 홈 기준 상대 경로로 바꿔 저장한다. */
async function migrateSettings(log) {
    const config = vscode.workspace.getConfiguration(SECTION);
    const inspected = config.inspect('remoteWorkspace');
    const value = inspected && inspected.globalValue;
    if (typeof value !== 'string' || !/^\s*[/~]/.test(value)) {
        return;
    }
    const user = String(config.get('user') || '').trim();
    const workspace = normalizeWorkspaceFolder(value, user);
    if (!workspace.error) {
        await config.update('remoteWorkspace', workspace.folder, vscode.ConfigurationTarget.Global);
        if (log) {
            log.info(`Migrated tosRemote.remoteWorkspace: ${value} → ${workspace.folder}`);
        }
    }
}

module.exports = { SECTION, EDITABLE_KEYS, getSettings, validateSettings, targetOf, updateSetting, migrateSettings };
