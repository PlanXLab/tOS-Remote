'use strict';

const fs = require('fs');
const vscode = require('vscode');
const { obscure } = require('./obscure');
const { findExistingKey, keyPathForCreation } = require('./ssh');
const { sftpEnv } = require('./rclone');
const { lastLine } = require('./util');
const { t } = require('./i18n');

function secretKey(target) {
    return `tosRemote.password/${target.user}@${target.host}:${target.port}`;
}

function isAuthError(message) {
    return /unable to authenticate|permission denied|auth.*fail|handshake failed/i.test(String(message || ''));
}

class AuthManager {
    constructor(context, ssh, rclone, logger) {
        this.context = context;
        this.ssh = ssh;
        this.rclone = rclone;
        this.logger = logger;
    }

    async getPassword(target) {
        return this.context.secrets.get(secretKey(target));
    }

    async hasPassword(target) {
        return !!(await this.getPassword(target));
    }

    async storePassword(target, password) {
        await this.context.secrets.store(secretKey(target), password);
    }

    async clearPassword(target) {
        await this.context.secrets.delete(secretKey(target));
    }

    async promptPassword(target, reason) {
        const prompt = t('Password for {0}', `${target.user}@${target.host}`);
        const password = await vscode.window.showInputBox({
            title: 'tOS Remote',
            prompt: reason ? `${prompt} (${reason})` : prompt,
            password: true,
            ignoreFocusOut: true
        });
        if (password) {
            await this.storePassword(target, password);
        }
        return password || undefined;
    }

    async keyWorks(settings, target) {
        const keyPath = findExistingKey(settings.identityFile);
        if (keyPath && (await this.ssh.testKey(target, keyPath))) {
            await this.context.globalState.update(`tosRemote.keyOk/${secretKey(target)}`, true);
            return keyPath;
        }
        await this.context.globalState.update(`tosRemote.keyOk/${secretKey(target)}`, false);
        return undefined;
    }

    wasKeyOk(target) {
        return this.context.globalState.get(`tosRemote.keyOk/${secretKey(target)}`) === true;
    }

    /**
     * SSH 키 인증을 우선 사용하고, 실패하면 저장된(또는 입력받은) 비밀번호를 사용한다.
     * @returns {Promise<{type: 'key', keyPath: string} | {type: 'password', obscured: string}>}
     */
    async resolve(settings, target, options = {}) {
        const keyPath = await this.keyWorks(settings, target);
        if (keyPath) {
            return { type: 'key', keyPath };
        }
        let password = await this.getPassword(target);
        if (!password && options.interactive) {
            password = await this.promptPassword(target, t('SSH key authentication failed'));
        }
        if (!password) {
            throw new Error(t('SSH key authentication failed and no password is saved. Register an SSH key or enter a password in the panel.'));
        }
        return { type: 'password', obscured: obscure(password) };
    }

    // 비밀번호 인증 확인 (rclone SFTP로 홈 디렉터리 조회)
    async testPassword(target, password) {
        const result = await this.rclone.runCli(['lsf', ':sftp:', '--max-depth', '1', '--contimeout', '10s', '--low-level-retries', '1', '--retries', '1'], {
            env: sftpEnv(target, { type: 'password', obscured: obscure(password) }),
            timeoutMs: 30000
        });
        return { ok: result.code === 0, error: result.code === 0 ? undefined : lastLine(result.stderr) };
    }

    /** PC의 SSH 공개 키를 보드의 ~/.ssh/authorized_keys에 등록한다 (비밀번호 1회 필요) */
    async setupKey(settings, target, report) {
        let keyPath = findExistingKey(settings.identityFile);
        if (!keyPath) {
            keyPath = keyPathForCreation(settings.identityFile);
            report(t('Creating an SSH key...'));
            await this.ssh.generateKey(keyPath);
        }
        if (await this.ssh.testKey(target, keyPath)) {
            await this.context.globalState.update(`tosRemote.keyOk/${secretKey(target)}`, true);
            return { keyPath, alreadyRegistered: true };
        }

        let password = await this.getPassword(target);
        if (!password) {
            password = await this.promptPassword(target, t('needed once to register the SSH key'));
        }
        if (!password) {
            throw new Error(t('Password entry was canceled.'));
        }

        const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
        const keyBody = publicKey.split(/\s+/).slice(0, 2).join(' ');
        const env = sftpEnv(target, { type: 'password', obscured: obscure(password) });
        const common = ['--contimeout', '10s', '--low-level-retries', '1', '--retries', '1'];

        report(t('Registering the public key on the board...'));
        const mkdir = await this.rclone.runCli(['mkdir', ':sftp:.ssh', ...common], { env, timeoutMs: 30000 });
        if (mkdir.code !== 0) {
            const message = lastLine(mkdir.stderr);
            if (isAuthError(message)) {
                await this.clearPassword(target);
                throw new Error(t('The password is incorrect.'));
            }
            throw new Error(t('Could not create ~/.ssh: {0}', message));
        }
        const current = await this.rclone.runCli(['cat', ':sftp:.ssh/authorized_keys', ...common], { env, timeoutMs: 30000 });
        const existing = current.code === 0 ? current.stdout : '';
        if (!existing.includes(keyBody)) {
            const content = `${existing.replace(/\s*$/, '')}${existing.trim() ? '\n' : ''}${publicKey}\n`;
            const write = await this.rclone.runCli(['rcat', ':sftp:.ssh/authorized_keys', ...common], { env, input: content, timeoutMs: 30000 });
            if (write.code !== 0) {
                throw new Error(t('Could not write authorized_keys: {0}', lastLine(write.stderr)));
            }
        }

        report(t('Checking key authentication...'));
        this.ssh.resetKnownHosts();
        if (!(await this.ssh.testKey(target, keyPath))) {
            throw new Error(t('The public key was registered, but key authentication failed. Check the permissions of ~/.ssh on the board (no group/other write access).'));
        }
        await this.context.globalState.update(`tosRemote.keyOk/${secretKey(target)}`, true);
        this.logger.info(`SSH key registered: ${keyPath} → ${target.user}@${target.host}`);
        return { keyPath, alreadyRegistered: false };
    }
}

module.exports = { AuthManager, isAuthError };
