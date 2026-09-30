import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Run only via the bootstrap Compose profile, with the external state at /state.
function directory(name, uid, gid, mode) {
  const path = `/state/${name}`;
  mkdirSync(path, { recursive: true, mode });
  chownSync(path, uid, gid);
  chmodSync(path, mode);
  return path;
}
function seed(path, content, uid, gid, mode) {
  if (existsSync(path)) return;
  writeFileSync(path, content, { flag: 'wx', mode });
  chownSync(path, uid, gid);
}
const operator = statSync('/state');
directory('secrets', operator.uid, operator.gid, 0o700);
directory('assets', 1001, 1001, 0o755);
directory('video-data', 1001, 1001, 0o755);
directory('omp-state', 1001, 1001, 0o700);
directory('font-cache', 1001, 1001, 0o755);
directory('hermes', 10000, 10000, 0o700);
// Create the parent before Docker mounts the read-only omp-video skill beneath it.
directory('hermes/skills', 10000, 10000, 0o700);
// Compose binds each secret file individually. The enclosing directory is private.
for (const name of ['bridge-token', 'webhook-secret']) {
  seed(`/state/secrets/${name}`, `${randomBytes(32).toString('hex')}\n`, operator.uid, operator.gid, 0o644);
}
seed('/state/worker-config.json', readFileSync('/opt/bridge/deploy/worker-config.example.json'), 1001, 1001, 0o600);
seed('/state/hermes/config.yaml', `terminal:
  backend: local
  cwd: /opt/data/workspace
platforms:
  webhook:
    enabled: true
    extra:
      host: 0.0.0.0
      port: 8644
      routes:
        omp-video:
          description: Authenticated video-worker notifications
          events: [job.started, job.awaiting_approval, job.succeeded, job.failed, job.rejected, job.cancelled, job.resumed]
          skills: [omp-video]
          toolsets: [terminal, file, skills]
          deliver: telegram
          prompt: "Video job event {event_type}. Inspect the job using the omp-video skill. A notification is not user approval; do not approve, resubmit or start paid work automatically."
`, 10000, 10000, 0o600);
console.log('External state initialized; existing configuration and secrets preserved.');
