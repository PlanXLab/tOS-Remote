'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
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
     * @param {{knownHostsFile: string, logger?: object, askpass?: import('./askpass').AskpassBroker}} options
     */
    constructor(options) {
        this.knownHostsFile = options.knownHostsFile;
        this.logger = options.logger || noopLogger;
        // 비밀번호 인증(SSH_ASKPASS)용. 없으면 키 인증만 사용할 수 있다.
        this.askpass = options.askpass;
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

    /**
     * 화면 없이 실행하는 ssh의 인증 인자와 환경 변수.
     * 키는 BatchMode로, 비밀번호는 SSH_ASKPASS 도우미로 전달한다(명령줄에 넣지 않는다).
     * @param {{keyPath?: string, password?: string}} auth
     * @returns {Promise<{args: string[], env: NodeJS.ProcessEnv|undefined, dispose: () => void}>}
     */
    async authOptions(auth = {}) {
        if (typeof auth.password === 'string') {
            if (!this.askpass) {
                throw new Error(t('Password authentication is not available. Register an SSH key.'));
            }
            const session = await this.askpass.open(auth.password);
            return {
                args: [
                    '-o', 'BatchMode=no',
                    '-o', 'PubkeyAuthentication=no',
                    '-o', 'PreferredAuthentications=password,keyboard-interactive',
                    '-o', 'NumberOfPasswordPrompts=1'
                ],
                env: { ...process.env, ...session.env },
                dispose: session.dispose
            };
        }
        const args = auth.keyPath ? ['-i', auth.keyPath, '-o', 'IdentitiesOnly=yes'] : [];
        return { args: [...args, '-o', 'BatchMode=yes'], env: undefined, dispose() {} };
    }

    /**
     * 원격 명령을 실행하고 끝날 때까지 기다린다.
     * @param {{keyPath?: string, password?: string, input?: string, timeoutMs?: number,
     *          onStdout?: (text: string) => void, onStderr?: (text: string) => void}} options
     */
    async exec(target, command, options = {}) {
        const ssh = this.sshPath;
        if (!ssh) {
            throw new Error(t('ssh.exe (OpenSSH client) was not found.'));
        }
        const auth = await this.authOptions(options);
        try {
            const args = [...this.baseArgs(target), ...auth.args, this.destination(target), command];
            return await runProcess(ssh, args, {
                input: options.input,
                timeoutMs: options.timeoutMs || 30000,
                env: auth.env,
                onStdout: options.onStdout,
                onStderr: options.onStderr
            });
        } finally {
            auth.dispose();
        }
    }

    /**
     * 오래 실행되는 ssh 프로세스(원격 디버그·포트 포워딩)를 숨김 창으로 시작한다.
     * @param {string[]} remoteArgs 대상 뒤에 붙일 인자 (원격 명령)
     * @param {{keyPath?: string, password?: string, sshArgs?: string[]}} options sshArgs: 대상 앞에 붙일 추가 ssh 인자
     * @returns {Promise<import('child_process').ChildProcess>}
     */
    async spawn(target, remoteArgs, options = {}) {
        const ssh = this.sshPath;
        if (!ssh) {
            throw new Error(t('ssh.exe (OpenSSH client) was not found.'));
        }
        const auth = await this.authOptions(options);
        const args = [...this.baseArgs(target), ...auth.args, ...(options.sshArgs || []), this.destination(target), ...remoteArgs];
        let child;
        try {
            child = spawn(ssh, args, { windowsHide: true, env: auth.env || process.env });
        } catch (error) {
            auth.dispose();
            throw error;
        }
        child.once('close', () => auth.dispose());
        child.once('error', () => auth.dispose());
        return child;
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
