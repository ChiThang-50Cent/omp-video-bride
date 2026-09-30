import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

execFileSync('/bin/sh', ['/opt/bridge/deploy/prepare-assets.sh', '--check', '/assets'], { stdio: 'inherit' });
const tmp = process.env.TMPDIR || '/tmp/omp-worker';
mkdirSync(tmp, { recursive: true });
const config = JSON.parse(readFileSync('/etc/omp-video-bridge/config.json', 'utf8'));
const secret = readFileSync('/run/secrets/webhook-secret', 'utf8').trim();
config.webhook = { url: config.webhook?.url || process.env.HERMES_WEBHOOK_URL, secret };
const configPath = join(tmp, 'worker-config.json');
writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
process.env.BRIDGE_CONFIG = configPath;
process.execve(process.execPath, [process.execPath, '--disable-warning=ExperimentalWarning', '/opt/bridge/src/main.ts'], process.env);
