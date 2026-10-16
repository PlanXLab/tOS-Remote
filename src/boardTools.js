'use strict';

// 보드 도구(debugpy, Jupyter) 확인과 설치.
// 보드에 인터넷이 없어도 되도록 PC에서 uv로 보드 Python 기준 의존성을 해석하고 휠을 내려받아(SHA-256 검증)
// 보드 임시 폴더로 복사한 뒤 sudo로 전역 환경에 설치한다(tOS: sudo pip install = uv, --break-system-packages).
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const scripts = require('./boardScripts');
const { uvEnv, resolvePackages, downloadWheels } = require('./packageResolver');
const { sftpEnv } = require('./rclone');
const { getSettings } = require('./settings');
const { lastLine, sleep, shellQuote } = require('./util');
const { t } = require('./i18n');

const PROBE_MAX_AGE_MS = 10 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

function groupLabel(group) {
    return group === 'jupyter' ? t('Jupyter (jupyter_server, ipykernel)') : t('debugging tools (debugpy)');
}

function targetOf(session) {
    return { host: session.host, port: session.port, user: session.user };
}

function targetError(code, probe) {
    switch (code) {
        case 'implementation':
            return t('Only CPython is supported on the board (found {0}).', probe.implementation);
        case 'version':
            return t('Unsupported Python version on the board: {0}', probe.version);
        case '32bit':
            return t('The board runs a 32-bit Python ({0}). A 64-bit Python (aarch64 or x86_64) is required.', probe.machine);
        case 'machine':
            return t('Unsupported board architecture: {0} (aarch64 or x86_64 required).', probe.machine);
        default:
            return t('Unsupported C library on the board: {0} {1} (glibc 2.17 or later required).', probe.libc || '?', probe.libcVersion);
    }
}

// 로그에 비밀번호가 섞이지 않도록 가린다
const { maskSecrets } = scripts;

function lineLogger(log, prefix, secrets) {
    let buffer = '';
    return {
        write(text) {
            buffer += text;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) {
                if (line.trim()) {
                    log.info(`${prefix} ${maskSecrets(line, secrets)}`);
                }
            }
        },
        flush() {
            if (buffer.trim()) {
                log.info(`${prefix} ${maskSecrets(buffer, secrets)}`);
            }
            buffer = '';
        }
    };
}

class BoardTools {
    /**
     * @param {{log: vscode.LogOutputChannel, ssh: any, rclone: any, sessionMgr: any, prereq: any, auth: any,
     *          storageDir: string, localDir: string}} services
     */
    constructor(services) {
        Object.assign(this, services);
        this.emitter = new vscode.EventEmitter();
        this.onDidChange = this.emitter.event;
        this.probe = undefined;
        this.checkedAt = 0;
        this.checking = undefined;
        this.installing = undefined;
        this.error = undefined;
        this.identity = undefined;
    }

    /** 이 창이 원격 작업 공간 창이면 세션. 다른 보드로 바뀌면 이전 확인 결과를 버리고, 세션에 더 새 결과가 있으면 가져온다. */
    currentSession() {
        const session = this.sessionMgr.readSession();
        if (!session || !this.sessionMgr.isOwnerWindow()) {
            return undefined;
        }
        if (session.identity !== this.identity) {
            this.identity = session.identity;
            this.probe = undefined;
            this.checkedAt = 0;
            this.error = undefined;
        }
        const saved = session.boardTools;
        if (saved && saved.probe && saved.checkedAt > this.checkedAt) {
            this.probe = saved.probe;
            this.checkedAt = saved.checkedAt;
        }
        return session;
    }

    requireSession() {
        const session = this.currentSession();
        if (!session) {
            throw new Error(t('Open the remote workspace in this window first.'));
        }
        return session;
    }

    status() {
        const available = !!this.currentSession();
        const tools = scripts.toolStatus(this.probe);
        const probe = this.probe;
        return {
            available,
            checking: !!this.checking,
            installing: this.installing,
            checked: !!tools,
            error: this.error,
            python: probe ? { version: probe.version, machine: probe.machine, libc: probe.libc ? `${probe.libc} ${probe.libcVersion}` : '' } : undefined,
            debug: tools && tools.debug,
            jupyter: tools && tools.jupyter
        };
    }

    fire() {
        this.emitter.fire(this.status());
    }

    /** 보드 도구 상태를 다시 확인한다 (SSH 1회). */
    check(options = {}) {
        if (!this.checking) {
            this.checking = this.runCheck(options).finally(() => {
                this.checking = undefined;
                this.fire();
            });
            this.fire();
        }
        return this.checking;
    }

    async runCheck(options) {
        const session = this.requireSession();
        try {
            const auth = await this.sessionMgr.sshAuth(session, { interactive: !!options.interactive });
            const result = await this.ssh.exec(targetOf(session), scripts.buildProbeCommand(session.pythonCommand), { ...auth, timeoutMs: 30000 });
            const probe = scripts.parseProbeOutput(result.stdout);
            if (!probe || probe.error) {
                throw new Error(t('Could not check the board tools: {0}', (probe && probe.error) || lastLine(result.stderr) || `exit ${result.code}`));
            }
            this.probe = probe;
            this.checkedAt = Date.now();
            this.error = undefined;
            this.sessionMgr.updateSession({ boardTools: { probe, checkedAt: this.checkedAt } }, session.identity);
            this.log.info(`Board tools: Python ${probe.version} (${probe.python}), debugpy=${probe.packages.debugpy || '-'}, `
                + `jupyter_server=${probe.packages.jupyter_server || '-'}, ipykernel=${probe.packages.ipykernel || '-'}, run_debug.sh=${probe.runDebug}`);
            return probe;
        } catch (error) {
            this.error = error.message;
            throw error;
        }
    }

    /** 최근 확인 결과가 있으면 그대로 쓰고, 없으면 확인한다. */
    async ensureProbe(options = {}) {
        this.requireSession();
        if (this.probe && Date.now() - this.checkedAt < (options.maxAgeMs || PROBE_MAX_AGE_MS)) {
            return this.probe;
        }
        return this.check(options);
    }

    /**
     * 보드에 도구를 설치한다. 이미 설치된 것은 다시 설치하지 않는다.
     * @param {'debug'|'jupyter'} group
     * @returns {Promise<boolean>} 설치(또는 이미 설치)되어 사용할 수 있으면 true
     */
    async install(group) {
        const label = groupLabel(group);
        if (this.installing) {
            vscode.window.showInformationMessage(t('Board tools are already being installed.'));
            return false;
        }
        let session;
        try {
            session = this.requireSession();
        } catch (error) {
            vscode.window.showInformationMessage(error.message);
            return false;
        }
        this.installing = group;
        this.fire();
        try {
            return await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: t('Installing {0} on tOS', label)
            }, (progress) => this.runInstall(session, group, label, (message) => progress.report({ message })));
        } catch (error) {
            if (error instanceof vscode.CancellationError) {
                this.log.info(`Board tools installation canceled (${group})`);
                return false;
            }
            await this.sessionMgr.reportError(t('Could not install {0} on the board.', label), error);
            return false;
        } finally {
            this.installing = undefined;
            this.fire();
        }
    }

    async runInstall(session, group, label, report) {
        report(t('Checking the board'));
        const probe = await this.check({ interactive: true });
        const plan = scripts.planInstall(probe, group);
        if (!plan.packages.length && !plan.runDebug) {
            vscode.window.showInformationMessage(t('{0} is already installed on the board.', label));
            return true;
        }
        const target = targetOf(session);
        const auth = await this.sessionMgr.sshAuth(session, { interactive: true });
        report(t('Checking administrator (sudo) access'));
        const sudoPassword = await this.resolveSudoPassword(target, auth);
        const secrets = [sudoPassword, auth.password];

        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-remote-pkg-'));
        let remoteDir;
        let installStarted = false;
        try {
            const wheelsDir = path.join(work, 'wheels');
            fs.mkdirSync(wheelsDir);
            let pipWheel;
            if (plan.packages.length) {
                pipWheel = await this.prepareWheels(probe, plan, work, wheelsDir, report);
            }
            fs.writeFileSync(path.join(work, 'root.sh'), scripts.buildRootInstallScript({ ...plan, python: probe.python, pipWheel, externallyManaged: probe.externallyManaged }), 'utf8');
            fs.writeFileSync(path.join(work, 'run_debug.sh'), scripts.RUN_DEBUG_SCRIPT, 'utf8');

            report(t('Uploading to the board'));
            await this.waitForLibrarySync(report);
            const temp = await this.ssh.exec(target, scripts.MKTEMP_COMMAND, { ...auth, timeoutMs: 30000 });
            remoteDir = scripts.parseTempDir(temp.stdout);
            if (!remoteDir) {
                throw new Error(t('Could not create a temporary folder on the board: {0}', lastLine(temp.stderr) || `exit ${temp.code}`));
            }
            await this.upload(session, work, remoteDir);

            report(t('Installing on the board (sudo)'));
            installStarted = true;
            const output = lineLogger(this.log, '[install]', secrets);
            const result = await this.ssh.exec(target, 'sh -s', {
                ...auth,
                input: scripts.buildInstallScript({ remoteDir, password: sudoPassword }),
                timeoutMs: INSTALL_TIMEOUT_MS,
                onStdout: (text) => output.write(text),
                onStderr: (text) => output.write(text)
            });
            output.flush();
            const exit = scripts.parseInstallExit(result.stdout);
            if (exit !== 0) {
                throw new Error(t('The installation on the board failed (exit {0}). See the log for details.', exit === undefined ? result.code : exit));
            }
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
            if (remoteDir && !installStarted) {
                this.ssh.exec(target, `rm -rf ${shellQuote(remoteDir)}`, { ...auth, timeoutMs: 15000 }).catch(() => {});
            }
        }

        report(t('Checking the installation'));
        const after = await this.check();
        const still = scripts.planInstall(after, group);
        if (still.packages.length || still.runDebug === 'create') {
            throw new Error(t('Installation finished, but these are still missing on the board: {0}', [...still.packages, ...(still.runDebug ? [scripts.RUN_DEBUG_PATH] : [])].join(', ')));
        }
        if (plan.packages.length) {
            this.checkDependencies(target, auth, after);
            // 새 패키지를 Pylance가 인식하도록 보드 라이브러리를 다시 동기화한다
            this.sessionMgr.syncLibraries(undefined, false).catch((error) => this.log.warn(`Library sync after install failed: ${error.message}`));
        }
        vscode.window.showInformationMessage(t('{0} installed on the board.', label));
        return true;
    }

    /** PC에서 보드용 패키지를 해석하고 내려받는다. @returns {Promise<string|undefined>} pip 휠 파일 이름 (pip이 없는 보드) */
    async prepareWheels(probe, plan, work, wheelsDir, report) {
        const target = scripts.resolveTarget(probe);
        if (target.error) {
            throw new Error(targetError(target.error, probe));
        }
        const uvPath = await this.prereq.ensureUv({ interactive: true });
        report(t('Resolving packages for the board (Python {0}, {1})', target.pythonVersion, target.platform));
        const requirements = plan.installer === 'pip-wheel' ? [...plan.packages, 'pip'] : plan.packages;
        const uvLog = lineLogger(this.log, '[uv]', []);
        const packages = await resolvePackages({
            uvPath,
            workDir: work,
            env: uvEnv({ cacheDir: path.join(this.localDir, 'uv-cache'), pythonDir: path.join(this.storageDir, 'uv-python') }),
            requirements,
            constraints: scripts.CONSTRAINTS,
            preferences: scripts.preferenceLines(probe),
            pythonVersion: target.pythonVersion,
            platform: target.platform,
            excludeNewer: getSettings().packageExcludeNewer,
            onStderr: (text) => {
                uvLog.write(text);
                if (/Downloading cpython/i.test(text)) {
                    report(t('Downloading the Python runtime for package resolution (first time only)'));
                }
            }
        });
        uvLog.flush();
        const needed = packages.filter((pkg) => !scripts.isInstalled(probe, pkg.name, pkg.version));
        const wheels = needed.flatMap((pkg) => pkg.wheels);
        this.log.info(`Resolved ${packages.length} package(s) for Python ${target.pythonVersion} ${target.platform}; downloading ${needed.length}: `
            + needed.map((pkg) => `${pkg.name}==${pkg.version}`).join(', '));
        let lastPercent = -1;
        await downloadWheels(wheels, wheelsDir, (received, total) => {
            const percent = total ? Math.floor((received / total) * 100) : 0;
            if (percent !== lastPercent && percent % 5 === 0) {
                lastPercent = percent;
                report(t('Downloading packages ({0}) {1}%', needed.length, percent));
            }
        });
        if (plan.installer !== 'pip-wheel') {
            return undefined;
        }
        const pip = needed.find((pkg) => scripts.normalizeName(pkg.name) === 'pip');
        return pip && pip.wheels[0].filename;
    }

    /** sudo가 비밀번호 없이 되면 ''. 아니면 저장된 비밀번호 → 입력 순으로 확인한다. */
    async resolveSudoPassword(target, auth) {
        const run = async (password) => {
            const result = await this.ssh.exec(target, 'sh -s', { ...auth, input: scripts.buildSudoCheckScript(password), timeoutMs: 30000 });
            const check = scripts.parseSudoCheck(result.stdout);
            if (check.state === 'unknown') {
                throw new Error(t('Could not check sudo on the board: {0}', lastLine(result.stderr) || `exit ${result.code}`));
            }
            return check;
        };
        let check = await run('');
        if (check.state === 'ok') {
            return '';
        }
        const saved = await this.auth.getPassword(target);
        let candidate = saved || undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
            if (candidate === undefined) {
                candidate = await vscode.window.showInputBox({
                    title: 'tOS Remote',
                    prompt: attempt === 0 || check.state !== 'denied'
                        ? t('sudo password for {0} (needed to install packages on the board)', `${target.user}@${target.host}`)
                        : t('The sudo password was not accepted. Enter it again.'),
                    password: true,
                    ignoreFocusOut: true
                });
                if (candidate === undefined) {
                    throw new vscode.CancellationError();
                }
            }
            check = await run(candidate);
            if (check.state === 'ok') {
                return candidate;
            }
            if (/sudoers|not allowed|may not run/i.test(check.message || '')) {
                throw new Error(t('The board user {0} cannot use sudo: {1}', target.user, check.message));
            }
            this.log.warn(`sudo password was not accepted: ${check.message || ''}`);
            candidate = undefined;
        }
        throw new Error(t('The sudo password was not accepted.'));
    }

    // Dropbear는 동시 접속 수를 제한하므로 라이브러리 동기화(최대 4연결)가 끝난 뒤 업로드한다
    async waitForLibrarySync(report) {
        for (let i = 0; this.sessionMgr.libSyncRunning && i < 600; i++) {
            if (i === 0) {
                report(t('Waiting for the Python library sync to finish'));
            }
            await sleep(1000);
        }
    }

    async upload(session, localDir, remoteDir) {
        const rcloneAuth = await this.sessionMgr.resolveSessionAuth(session);
        const result = await this.rclone.runCli([
            'copy', localDir, `:sftp:${remoteDir}`,
            '--no-check-dest',
            '--transfers', '3',
            '--checkers', '3',
            '--sftp-connections', '3',
            '--contimeout', '15s',
            '--retries', '2',
            '--low-level-retries', '3'
        ], { env: sftpEnv(targetOf(session), rcloneAuth), timeoutMs: 15 * 60 * 1000 });
        if (result.code !== 0) {
            throw new Error(t('Uploading to the board failed: {0}', lastLine(result.stderr) || `exit ${result.code}`));
        }
    }

    // 설치 후 의존성 충돌만 경고한다 (설치 자체는 성공)
    checkDependencies(target, auth, probe) {
        if (!probe.pip) {
            return;
        }
        this.ssh.exec(target, `${shellQuote(probe.python)} -m pip check`, { ...auth, timeoutMs: 60000 })
            .then((result) => {
                if (result.code !== 0) {
                    this.log.warn(`pip check reported problems:\n${result.stdout.trim()}`);
                    vscode.window.showWarningMessage(t('Some Python packages on the board have unmet dependencies. See the log for details.'));
                }
            })
            .catch((error) => this.log.debug(`pip check failed: ${error.message}`));
    }
}

module.exports = { BoardTools, groupLabel };
