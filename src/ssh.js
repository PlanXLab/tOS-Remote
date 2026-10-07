'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProcess, findExecutable, removeFile, noopLogger } = require('./util');
const { t } = require('./i18n');

const SYSTEM_OPENSSH_DIR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH');
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

function findOpenSshTool(name) {
    const systemPath = path.join(SYSTEM_OPENSSH_DIR, name);
    return fs.existsSync(systemPath) ? systemPath : findExecutable(name);
}

function expandHome(file) {
    const text = String(file || '').trim();
    if (!text) {
        return '';
    }
    return text.startsWith('~') ? path.join(os.homedir(), text.slice(1)) : text;
}

function keyCandidates(identityFile) {
    const configured = expandHome(identityFile);
    if (configured) {
        return [configured];
    }
    return DEFAULT_KEY_NAMES.map((name) => path.join(os.homedir(), '.ssh', name));
}

function findExistingKey(identityFile) {
    return keyCandidates(identityFile).find((file) => fs.existsSync(file) && fs.existsSync(`${file}.pub`));
}

function keyPathForCreation(identityFile) {
    return expandHome(identityFile) || path.join(os.homedir(), '.ssh', 'id_ed25519');
}

class SshClient {
    /**
     * @param {{knownHostsFile: string, logger?: object}} options
     */
    constructor(options) {
        this.knownHostsFile = options.knownHostsFile;
        this.logger = options.logger || noopLogger;
    }

    get sshPath() {
        return findOpenSshTool('ssh.exe');
    }

    get keygenPath() {
        return findOpenSshTool('ssh-keygen.exe');
    }

    // 보드 재설치로 호스트 키가 바뀌어도 접속되도록 확장 전용 known_hosts를 사용하고 매 연결 시 초기화한다
    resetKnownHosts() {
        removeFile(this.knownHostsFile);
    }

    destination(target) {
        return `${target.user}@${target.host}`;
    }

    baseArgs(target, options = {}) {
        const args = [
            '-p', String(target.port),
            '-o', 'StrictHostKeyChecking=no',
            '-o', `UserKnownHostsFile="${this.knownHostsFile.replace(/\\/g, '/')}"`,
            '-o', 'LogLevel=ERROR',
            '-o', 'ConnectTimeout=8',
            '-o', 'ServerAliveInterval=15'
        ];
        if (options.keyPath) {
            args.push('-i', options.keyPath, '-o', 'IdentitiesOnly=yes');
        }
        if (options.batch) {
            args.push('-o', 'BatchMode=yes');
        }
        return args;
    }

    async exec(target, command, options = {}) {
        const ssh = this.sshPath;
        if (!ssh) {
            throw new Error(t('ssh.exe (OpenSSH client) was not found.'));
        }
        const args = [...this.baseArgs(target, { keyPath: options.keyPath, batch: true }), this.destination(target), command];
        return runProcess(ssh, args, { input: options.input, timeoutMs: options.timeoutMs || 30000 });
    }

    async testKey(target, keyPath) {
        if (!keyPath || !fs.existsSync(keyPath)) {
            return false;
        }
        try {
            const result = await this.exec(target, 'echo TOS_AUTH_OK', { keyPath, timeoutMs: 20000 });
            const ok = result.code === 0 && result.stdout.includes('TOS_AUTH_OK');
            if (!ok) {
                this.logger.info(`SSH key authentication failed (${keyPath}): ${result.stderr.trim() || `exit ${result.code}`}`);
            }
            return ok;
        } catch (error) {
            this.logger.warn(`SSH key check error: ${error.message}`);
            return false;
        }
    }

    async generateKey(keyPath) {
        const keygen = this.keygenPath;
        if (!keygen) {
            throw new Error(t('ssh-keygen.exe (OpenSSH client) was not found.'));
        }
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        const result = await runProcess(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', `tos-remote@${os.hostname()}`, '-f', keyPath], { timeoutMs: 30000 });
        if (result.code !== 0 || !fs.existsSync(`${keyPath}.pub`)) {
            throw new Error(t('SSH key generation failed: {0}', result.stderr.trim() || `exit ${result.code}`));
        }
        this.logger.info(`SSH key created: ${keyPath}`);
    }
}

module.exports = { SshClient, findExistingKey, keyPathForCreation, expandHome, findOpenSshTool };
