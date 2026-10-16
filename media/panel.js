// @ts-check
(function () {
    // eslint-disable-next-line no-undef
    const vscode = acquireVsCodeApi();
    const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

    // 확장이 현재 표시 언어로 번역해 넣어 준 문자열
    const L = JSON.parse(($('l10n').textContent) || '{}');
    const fmt = (text, ...args) => String(text).replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));

    const PHASE_TEXT = {
        idle: ['off', L.phaseIdle],
        opening: ['busy', L.phaseOpening],
        reconnecting: ['warn', L.phaseReconnecting],
        closing: ['busy', L.phaseClosing],
        open: ['on', L.phaseOpen],
        elsewhere: ['on', L.phaseElsewhere],
        detached: ['warn', L.phaseDetached]
    };

    let state;
    let prereqAutoOpened = false;

    function show(id, visible) {
        $(id).style.display = visible ? '' : 'none';
    }

    function setLine(id, text) {
        $(id).textContent = text;
        show(id, !!text);
    }

    function mark(id, ok, unknown) {
        const el = $(id);
        el.className = `mark ${ok ? 'ok' : unknown ? 'unknown' : 'bad'}`;
        el.textContent = ok ? '✓' : unknown ? '?' : '✗';
    }

    function neutral(id) {
        const el = $(id);
        el.className = 'mark unknown';
        el.textContent = '–';
    }

    // 보드 도구 (원격 작업 공간 창에서만): Python 정보, debugpy·run_debug.sh, Jupyter 패키지·서버
    function renderTools() {
        const tools = state.tools || {};
        const jupyter = state.jupyter || {};
        const busy = !!tools.checking || !!tools.installing;
        let hint = '';
        if (!tools.available) {
            hint = L.toolsUnavailable;
        } else if (!tools.checked) {
            hint = tools.checking ? L.checking : tools.error ? fmt(L.toolsError, tools.error) : L.toolsNotChecked;
        } else if (tools.error) {
            hint = fmt(L.toolsError, tools.error);
        }
        setLine('toolsHint', hint);
        $('toolsBadge').textContent = tools.installing ? L.toolsInstalling : tools.checking ? L.checking : '';
        $('toolsBadge').className = 'summary-badge';
        show('toolsList', !!tools.available && !!tools.checked);

        if (tools.python) {
            mark('pythonMark', true);
            $('pythonText').textContent = fmt(L.pythonInfo, tools.python.version, tools.python.machine, tools.python.libc);
        }
        const debug = tools.debug;
        if (debug) {
            mark('debugMark', debug.ready, !!debug.debugpy && !debug.ready);
            $('debugText').textContent = !debug.debugpy ? L.debugMissing : debug.runDebug ? fmt(L.debugReady, debug.debugpy) : fmt(L.debugNoScript, debug.debugpy);
        }
        show('btnInstallDebug', !!debug && !debug.ready);
        const packages = tools.jupyter;
        if (packages) {
            mark('jupyterMark', packages.ready);
            $('jupyterText').textContent = packages.ready ? fmt(L.jupyterReady, packages.jupyterServer, packages.ipykernel) : L.jupyterMissing;
        }
        show('btnInstallJupyter', !!packages && !packages.ready);

        const phase = jupyter.phase || 'stopped';
        show('jupyterServerRow', !!packages && (packages.ready || phase !== 'stopped'));
        $('jupyterDot').className = `dot ${{ running: 'on', reconnecting: 'warn', starting: 'busy', stopping: 'busy' }[phase] || ''}`;
        const serverText = {
            starting: L.jupyterStarting,
            running: fmt(L.jupyterRunning, jupyter.localPort),
            reconnecting: L.jupyterReconnecting,
            stopping: L.jupyterStopping
        };
        $('jupyterServerText').textContent = serverText[phase] || L.jupyterStopped;
        show('btnJupyterStart', phase === 'stopped');
        show('btnJupyterStop', phase === 'running' || phase === 'reconnecting');
        let jupyterHint = '';
        if (tools.available && phase === 'running') {
            jupyterHint = jupyter.extensionInstalled ? L.jupyterHint : L.jupyterExtensionMissing;
        } else if (tools.available && phase === 'stopped' && jupyter.error) {
            jupyterHint = jupyter.error;
        }
        setLine('jupyterHint', jupyterHint);

        for (const id of ['btnInstallDebug', 'btnInstallJupyter', 'btnJupyterStart', 'btnJupyterStop', 'btnToolsCheck', 'btnJupyterLog']) {
            /** @type {HTMLButtonElement} */ ($(id)).disabled = busy || phase === 'starting' || phase === 'stopping';
        }
        show('btnToolsCheck', !!tools.available);
        show('btnJupyterLog', !!tools.available && !!packages && packages.ready);
    }

    // 작업 공간은 /home/<계정>/ 아래 상대 경로만 입력한다. 앞부분은 계정으로 자동 표시.
    function updateWorkspacePrefix(user) {
        const name = String(user || '').trim();
        $('workspacePrefix').textContent = name === 'root' ? '/root/' : `/home/${name || '…'}/`;
    }

    $('user').addEventListener('input', () => updateWorkspacePrefix(/** @type {HTMLInputElement} */ ($('user')).value));

    function render() {
        if (!state) {
            return;
        }
        const phase = state.phase;
        const busy = phase === 'opening' || phase === 'closing' || phase === 'reconnecting';
        const [dot, text] = PHASE_TEXT[phase] || PHASE_TEXT.idle;
        $('statusDot').className = `dot ${dot}`;
        $('statusText').textContent = text;

        // 상태 카드: 1) 계정·IP 2) 작업 공간·가상 드라이브 3) 인증
        const s = state.session;
        const hasDetails = !!s && phase !== 'idle';
        setLine('statusAccount', hasDetails ? `${s.user}@${s.host}${s.port && s.port !== 22 ? `:${s.port}` : ''}` : '');
        setLine('statusWorkspace', hasDetails ? `${s.remoteWorkspace} → ${s.drive}` : '');
        setLine('statusAuth', hasDetails ? (s.authType === 'key' ? L.authKey : L.authPassword) : '');
        const extra = [];
        if (state.pendingUploads > 0) {
            extra.push(fmt(L.pendingUploads, state.pendingUploads));
        }
        if (state.libSyncRunning) {
            extra.push(L.libSyncRunning);
        }
        setLine('statusExtra', extra.join('\n'));

        show('btnOpen', phase === 'idle' || phase === 'opening' || phase === 'detached');
        $('btnOpen').textContent = phase === 'detached' ? L.reopenWorkspace : L.openWorkspace;
        show('btnFocus', phase === 'elsewhere');
        show('btnClose', phase === 'open' || phase === 'detached' || phase === 'reconnecting' || phase === 'closing');
        $('btnClose').textContent = phase === 'detached' ? L.unmount : L.closeWorkspace;
        for (const id of ['btnOpen', 'btnFocus', 'btnClose']) {
            /** @type {HTMLButtonElement} */ ($(id)).disabled = busy && !(id === 'btnClose' && phase === 'reconnecting');
        }

        // 연결 중에는 보드 설정을 바꿀 수 없다 (닫은 뒤 변경)
        const locked = phase !== 'idle';
        for (const el of document.querySelectorAll('[data-setting]')) {
            const input = /** @type {HTMLInputElement} */ (el);
            const key = input.dataset.setting || '';
            input.disabled = locked;
            if (document.activeElement !== input) {
                input.value = state.settings[key] === undefined ? '' : String(state.settings[key]);
            }
        }
        $('formHint').textContent = locked ? L.settingsLocked : '';
        updateWorkspacePrefix(document.activeElement === $('user') ? /** @type {HTMLInputElement} */ ($('user')).value : state.settings.user);
        /** @type {HTMLButtonElement} */ ($('btnTest')).disabled = busy;

        const test = state.lastTest;
        $('testResult').textContent = test ? `${test.ok ? '✓' : '✗'} ${test.message}` : '';
        $('testResult').className = `test-result ${test ? (test.ok ? 'ok' : 'bad') : ''}`;

        const auth = state.auth;
        mark('keyMark', auth.keyOk, !auth.keyOk && !!auth.keyFile);
        $('keyText').textContent = auth.keyOk ? L.keyOk : auth.keyFile ? L.keyUnverified : L.keyNone;
        $('btnKey').textContent = auth.keyOk ? L.checkAgain : L.registerKey;
        mark('pwMark', auth.passwordSaved, !auth.passwordSaved);
        $('pwText').textContent = auth.passwordSaved ? L.passwordSaved : L.passwordNotSaved;
        show('btnPwClear', auth.passwordSaved);
        $('btnPwSet').textContent = auth.passwordSaved ? L.change : L.save;

        const p = state.prereq;
        const rcloneOk = !!p.rcloneVersion;
        mark('winfspMark', p.winfsp, !p.checked);
        mark('rcloneMark', rcloneOk, !p.checked);
        mark('sshMark', p.ssh, !p.checked);
        $('rcloneText').textContent = rcloneOk ? `rclone v${p.rcloneVersion}${p.customRclone ? ` ${L.customRclone}` : ''}` : 'rclone';
        // 점검이 끝나기 전에는 설치 버튼을 숨겨 "내려받기"가 잠깐 보이지 않게 한다.
        // rclone은 한 번 설치하면 업데이트하지 않으므로 설치된 뒤에는 버튼을 표시하지 않는다.
        show('btnWinFsp', p.checked && !p.winfsp);
        show('btnRclone', p.checked && !p.customRclone && !rcloneOk);
        const allReady = p.winfsp && rcloneOk && p.ssh;
        $('prereqBadge').textContent = !p.checked ? (allReady ? L.readyChecking : L.checking) : allReady ? L.ready : L.needsAttention;
        $('prereqBadge').className = `summary-badge ${allReady ? 'ok' : p.checked ? 'bad' : ''}`;
        if (p.checked && !allReady && !prereqAutoOpened) {
            prereqAutoOpened = true;
            /** @type {HTMLDetailsElement} */ ($('prereqSection')).open = true;
        }

        // uv: 보드 패키지 설치에만 필요하므로 준비 상태 요약에는 넣지 않는다
        if (p.uvVersion) {
            mark('uvMark', true);
            $('uvText').textContent = fmt(L.uvInstalled, p.uvVersion);
        } else {
            neutral('uvMark');
            $('uvText').textContent = L.uvNotInstalled;
        }
        show('btnUv', p.checked && !p.uvVersion);

        renderTools();

        const hasSession = !!s && (phase === 'open' || phase === 'detached' || phase === 'elsewhere');
        /** @type {HTMLButtonElement} */ ($('btnSync')).disabled = !hasSession || state.libSyncRunning;
        /** @type {HTMLButtonElement} */ ($('btnRefresh')).disabled = !state.mounted;
    }

    document.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        const button = /** @type {HTMLButtonElement|null} */ (target.closest('[data-command]'));
        if (button && !button.disabled) {
            vscode.postMessage({ type: 'command', id: button.dataset.command });
        }
    });

    for (const el of document.querySelectorAll('[data-setting]')) {
        const input = /** @type {HTMLInputElement} */ (el);
        input.addEventListener('change', () => {
            input.classList.remove('invalid');
            input.title = '';
            vscode.postMessage({ type: 'setting', key: input.dataset.setting, value: input.value });
        });
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                input.blur();
            }
        });
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'state') {
            state = message.state;
            render();
        } else if (message.type === 'settingError') {
            const input = document.querySelector(`[data-setting="${message.key}"]`);
            if (input) {
                input.classList.add('invalid');
                /** @type {HTMLElement} */ (input).title = message.message;
            }
            $('formHint').textContent = message.message;
        }
    });

    vscode.postMessage({ type: 'ready' });
})();
