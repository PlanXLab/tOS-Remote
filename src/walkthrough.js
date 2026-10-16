'use strict';

// 시작 가이드(walkthrough) 단계 완료를 "Mark Done" 없이 실제 상태로 판단해 컨텍스트 키로 알린다.
// 연결 확인·작업 공간 열기 결과는 저장해 두어 VS Code를 다시 시작해도 완료 상태가 유지된다.
const OPENED_KEY = 'tosRemote.workspaceOpened';

function connectionKey(target) {
    return `tosRemote.connectionOk/${target.user}@${target.host}:${target.port}`;
}

/**
 * @param {{target?: {host: string, port: number, user: string}, keyOk: boolean, connectionOk: boolean, workspaceOpened: boolean}} state
 * @returns {Record<string, boolean>} 컨텍스트 키 → 값
 */
function walkthroughContext({ target, keyOk, connectionOk, workspaceOpened }) {
    return {
        'tosRemote.sshKeyReady': !!target && !!keyOk,
        // SSH 키가 동작하거나 작업 공간을 연 적이 있으면 보드 연결은 이미 확인된 것이다
        'tosRemote.boardConnected': (!!target && (!!keyOk || !!connectionOk)) || !!workspaceOpened,
        'tosRemote.workspaceOpened': !!workspaceOpened
    };
}

class WalkthroughState {
    /**
     * @param {{globalState: {get(key: string): any, update(key: string, value: any): Thenable<void>},
     *          setContext: (key: string, value: boolean) => any}} options
     */
    constructor(options) {
        this.globalState = options.globalState;
        this.setContext = options.setContext;
        this.last = {};
    }

    async markConnected(target) {
        if (target && this.globalState.get(connectionKey(target)) !== true) {
            await this.globalState.update(connectionKey(target), true);
        }
    }

    async markOpened() {
        if (this.globalState.get(OPENED_KEY) !== true) {
            await this.globalState.update(OPENED_KEY, true);
        }
    }

    /** 바뀐 컨텍스트 키만 다시 알린다. */
    update({ target, keyOk }) {
        const values = walkthroughContext({
            target,
            keyOk,
            connectionOk: !!target && this.globalState.get(connectionKey(target)) === true,
            workspaceOpened: this.globalState.get(OPENED_KEY) === true
        });
        for (const [key, value] of Object.entries(values)) {
            if (this.last[key] !== value) {
                this.last[key] = value;
                this.setContext(key, value);
            }
        }
        return values;
    }
}

module.exports = { WalkthroughState, walkthroughContext, connectionKey };
