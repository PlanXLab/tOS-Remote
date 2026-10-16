'use strict';

// Network-enabled checks for the actual platform archives, executable permissions and SFTP sync.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installRclone, installUv, getUvVersion } = require('../src/installer');
const { Rclone } = require('../src/rclone');
const { runProcess } = require('../src/util');

async function run() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tos-install-test-'));
    try {
        const binDir = path.join(work, 'bin');
        const rclone = await installRclone({ binDir });
        const uv = await installUv({ binDir });
        const client = new Rclone({ storageDir: work, cacheDir: path.join(work, 'cache'), getExePath: () => rclone.exePath });
        assert.strictEqual(await client.getVersion(), rclone.version);
        assert.strictEqual(await getUvVersion(uv.exePath), uv.version);
        if (process.platform !== 'win32') {
            assert.strictEqual(fs.statSync(rclone.exePath).mode & 0o777, 0o755);
            assert.strictEqual(fs.statSync(uv.exePath).mode & 0o777, 0o755);
        }
        console.log(`Verified ${process.platform}/${process.arch}: rclone ${rclone.version}, uv ${uv.version}`);
        const result = await runProcess(process.execPath, [path.join(__dirname, 'run.js')], {
            env: { ...process.env, TOS_TEST_RCLONE: rclone.exePath },
            timeoutMs: 180000,
            onStdout: (text) => process.stdout.write(text),
            onStderr: (text) => process.stderr.write(text)
        });
        assert.strictEqual(result.code, 0, 'Unit/SFTP suite failed');
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
