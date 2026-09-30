#!/bin/sh
# Portable host installer for the bridge systemd unit.
#
# The default mode validates the selected configuration, installs the rendered
# unit, and reloads systemd. It deliberately does not enable, start, or restart
# production: pass --enable and/or --start/--restart explicitly.
set -eu

usage() {
  cat <<'USAGE'
Usage:
  sh deploy/install.sh [options]

Options:
  --user USER       systemd service user (default: SUDO_USER, or caller)
  --repo DIR        repository root (default: this checkout)
  --node PATH       Node executable (default: command -v node)
  --config FILE     JSON config (default: USER's ~/.config/omp-video-bridge/config.json)
  --check, --check-only
                   validate Node, schema, secrets, provider tools, and paths; do not write or call systemd
  --print-unit      validate and print the rendered unit; do not write or call systemd
  --enable          explicitly enable the unit at boot (install mode only)
  --start           explicitly start the unit after installation
  --restart         explicitly restart the unit after installation
  -h, --help        show this help

Install mode writes /etc/systemd/system/omp-video-bridge.service and runs
systemctl daemon-reload. It requires the caller to invoke it as root (usually
with sudo); it never invokes sudo itself. No production service action occurs
unless --enable, --start, or --restart is supplied.
USAGE
}

die() { echo "install: $*" >&2; exit 1; }

check_only=0
print_unit=0
enable=0
start=0
restart=0
user_arg=
repo_arg=
node_arg=
config_arg=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --user)
      [ "$#" -ge 2 ] || die "--user needs a value"
      user_arg=$2
      shift 2
      ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo needs a value"
      repo_arg=$2
      shift 2
      ;;
    --node)
      [ "$#" -ge 2 ] || die "--node needs a value"
      node_arg=$2
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || die "--config needs a value"
      config_arg=$2
      shift 2
      ;;
    --check|--check-only)
      check_only=1
      shift
      ;;
    --print-unit)
      print_unit=1
      shift
      ;;
    --enable)
      enable=1
      shift
      ;;
    --start)
      start=1
      shift
      ;;
    --restart)
      restart=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option '$1' (try --help)"
      ;;
  esac
done

[ "$start" -eq 0 ] || [ "$restart" -eq 0 ] || die "--start and --restart are mutually exclusive"
[ "$check_only" -eq 0 ] || { [ "$enable" -eq 0 ] && [ "$start" -eq 0 ] && [ "$restart" -eq 0 ] || die "--check-only cannot be combined with install actions"; }
[ "$print_unit" -eq 0 ] || { [ "$check_only" -eq 0 ] && [ "$enable" -eq 0 ] && [ "$start" -eq 0 ] && [ "$restart" -eq 0 ] || die "--print-unit cannot be combined with other actions"; }

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_input=${repo_arg:-$(CDPATH= cd -- "$here/.." && pwd -P)}

if [ -n "$user_arg" ]; then
  service_user=$user_arg
elif [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  service_user=$SUDO_USER
else
  service_user=$(id -un)
fi

[ -n "$service_user" ] || die "could not determine service user; pass --user"
[ "$service_user" != "root" ] || die "refusing to install a root-owned service; pass --user with an unprivileged account"

passwd_entry=$(getent passwd "$service_user" 2>/dev/null || true)
[ -n "$passwd_entry" ] || die "service user does not exist: $service_user"
service_home=$(printf '%s\n' "$passwd_entry" | cut -d: -f6)
[ -n "$service_home" ] || die "service user has no home directory: $service_user"

repo_input=${repo_input%/}
[ -n "$repo_input" ] || repo_input=/
case "$repo_input$node_arg$config_arg" in
  *[[:space:]]*) die "installer paths cannot contain whitespace; use a path without spaces" ;;
esac

repo=$(realpath -e -- "$repo_input" 2>/dev/null || true)
[ -n "$repo" ] || die "repository does not exist: $repo_input"
[ -f "$repo/src/main.ts" ] || die "repository is missing src/main.ts: $repo"
[ -f "$repo/src/config.ts" ] || die "repository is missing src/config.ts: $repo"
[ -f "$repo/package.json" ] || die "repository is missing package.json: $repo"

if [ -n "$node_arg" ]; then
  node_input=$node_arg
elif [ -n "${BRIDGE_NODE:-}" ]; then
  node_input=$BRIDGE_NODE
else
  node_input=$(command -v node 2>/dev/null || true)
fi
[ -n "$node_input" ] || die "Node executable not found; pass --node /absolute/path/to/node"
case "$node_input" in
  */*) ;;
  *) node_input=$(command -v "$node_input" 2>/dev/null || true) ;;
esac
[ -n "$node_input" ] || die "Node executable not found: $node_arg"
node=$(realpath -e -- "$node_input" 2>/dev/null || true)
[ -n "$node" ] || die "Node executable does not exist: $node_input"
[ -x "$node" ] || die "Node executable is not executable: $node"

if [ -n "$config_arg" ]; then
  config_input=$config_arg
elif [ -n "${BRIDGE_CONFIG:-}" ]; then
  config_input=$BRIDGE_CONFIG
else
  config_input=$service_home/.config/omp-video-bridge/config.json
fi
case "$config_input" in
  /*) ;;
  *) die "config must be an absolute path: $config_input" ;;
esac
config=$(realpath -e -- "$config_input" 2>/dev/null || true)
[ -n "$config" ] || die "configuration file does not exist: $config_input"

template=$here/omp-video-bridge.service
[ -f "$template" ] || die "unit template missing: $template"
service_path="$(dirname -- "$node"):$service_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
service_uid=$(id -u "$service_user")
service_gid=$(id -g "$service_user")

# This invokes the actual application loader and ConfigSchema through the
# selected Node binary. No configuration is sourced or eval'd by this script.
if ! HOME=$service_home \
BRIDGE_REPO=$repo \
BRIDGE_CONFIG=$config \
BRIDGE_CONFIG_INPUT=$config_input \
BRIDGE_SERVICE_USER=$service_user \
BRIDGE_SERVICE_UID=$service_uid \
BRIDGE_SERVICE_GID=$service_gid \
BRIDGE_SERVICE_PATH=$service_path \
"$node" --disable-warning=ExperimentalWarning --input-type=module <<'NODE'
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const errors = [];
const repo = process.env.BRIDGE_REPO;
const configPath = process.env.BRIDGE_CONFIG;
const configInput = process.env.BRIDGE_CONFIG_INPUT;
const uid = Number(process.env.BRIDGE_SERVICE_UID);
const gid = Number(process.env.BRIDGE_SERVICE_GID);

const fail = message => errors.push(message);
const stat = (path, label, required = true) => {
  try { return statSync(path); } catch { if (required) fail(`${label} does not exist: ${path}`); return null; }
};
const absolute = (value, label) => {
  if (typeof value !== "string" || !value.trim()) { fail(`${label} must be nonempty`); return false; }
  if (!isAbsolute(value)) { fail(`${label} must be absolute: ${value}`); return false; }
  return true;
};
const executable = (value, label) => {
  if (!absolute(value, label)) return;
  const s = stat(value, label);
  if (!s) return;
  if (!s.isFile() || (s.mode & 0o111) === 0) fail(`${label} must be an executable file: ${value}`);
};
const readableByService = (path, label, s) => {
  const mode = s.mode & 0o777;
  const ownerReadable = s.uid === uid && (mode & 0o400) !== 0;
  const groupReadable = s.gid === gid && (mode & 0o040) !== 0;
  const otherReadable = (mode & 0o004) !== 0;
  if (!ownerReadable && !groupReadable && !otherReadable) fail(`${label} is not readable by ${process.env.BRIDGE_SERVICE_USER}: ${path}`);
};
const writableByService = (path, label, s) => {
  const mode = s.mode & 0o777;
  const ownerWritable = s.uid === uid && (mode & 0o300) === 0o300;
  const groupWritable = s.gid === gid && (mode & 0o030) === 0o030;
  const otherWritable = (mode & 0o003) === 0o003;
  if (!ownerWritable && !groupWritable && !otherWritable) fail(`${label} is not writable/searchable by ${process.env.BRIDGE_SERVICE_USER}: ${path}`);
};

if (!repo || !configPath) {
  fail("internal installer paths are missing");
} else {
  const version = process.versions.node.split(".").map(Number);
  const supportedNode = (version[0] === 22 && version[1] >= 20) || version[0] === 24 || version[0] >= 26;
  if (!supportedNode) fail(`Node ${process.versions.node} is unsupported; use ^22.20.0, ^24, or >=26`);

  let cfg;
  let configMode;
  try {
    const { loadConfig } = await import(pathToFileURL(join(repo, "src/config.ts")).href);
    cfg = loadConfig({ BRIDGE_CONFIG: configPath });
  } catch (error) {
    fail(`configuration schema rejected ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const configStat = lstatSync(configInput);
    const mode = configStat.mode & 0o777;
    configMode = mode;
    if (configStat.isSymbolicLink()) fail(`configuration must not be a symlink: ${configInput}`);
    if ((mode & 0o022) !== 0) fail(`configuration must not be group/world-writable: ${configInput}`);
    readableByService(configInput, "configuration", configStat);
  } catch {
    fail(`configuration cannot be inspected: ${configInput}`);
  }

  if (cfg) {
    if (cfg.webhook && configMode !== undefined && (configMode & 0o077) !== 0) fail(`configuration with webhook.secret must not be group/world-readable: ${configInput}`);
    absolute(cfg.tokenFile, "tokenFile");
    absolute(cfg.omp?.bin, "omp.bin");
    if (Array.isArray(cfg.omp?.skillDirs)) {
      for (const [index, value] of cfg.omp.skillDirs.entries()) absolute(value, `omp.skillDirs[${index}]`);
    }
    executable(cfg.omp?.bin, "omp.bin");

    try {
      const tokenStat = lstatSync(cfg.tokenFile);
      if (tokenStat.isSymbolicLink() || !tokenStat.isFile()) fail(`tokenFile must be a regular file, not a symlink: ${cfg.tokenFile}`);
      const token = readFileSync(cfg.tokenFile, "utf8");
      if (token.trim().length < 16) fail(`tokenFile must contain a nonempty token of at least 16 characters: ${cfg.tokenFile}`);
      const mode = tokenStat.mode & 0o777;
      if ((mode & 0o077) !== 0) fail(`tokenFile must not be group/world-readable: ${cfg.tokenFile}`);
      readableByService(cfg.tokenFile, "tokenFile", tokenStat);
    } catch (error) {
      fail(`tokenFile cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    const parent = dirname(cfg.dataDir);
    const dataStat = stat(cfg.dataDir, "dataDir", false);
    if (dataStat && !dataStat.isDirectory()) fail(`dataDir must be a directory: ${cfg.dataDir}`);
    if (!dataStat) {
      const parentStat = stat(parent, "dataDir parent");
      if (parentStat && !parentStat.isDirectory()) fail(`dataDir parent must be a directory: ${parent}`);
      if (parentStat) writableByService(parent, "dataDir parent", parentStat);
    } else {
      writableByService(cfg.dataDir, "dataDir", dataStat);
    }

    const providers = [
      ["HYPERFRAMES_BROWSER_PATH", true],
      ["HYPERFRAMES_PYTHON", true],
      ["HYPERFRAMES_WHISPER_PATH", false],
    ];
    for (const [name, required] of providers) {
      const value = cfg.env?.[name];
      if (required && (typeof value !== "string" || !value.trim())) fail(`env.${name} must be configured with an executable provider path`);
      if (value !== undefined) executable(value, `env.${name}`);
    }

    for (const command of ["ffmpeg", "ffprobe"]) {
      const probe = spawnSync(command, ["-version"], { env: { ...process.env, PATH: process.env.BRIDGE_SERVICE_PATH }, stdio: "ignore" });
      if (probe.error || probe.status !== 0) fail(`${command} is not executable through the service PATH`);
    }

    if (cfg.webhook) {
      const secret = cfg.webhook.secret.trim();
      if (secret.length < 16) fail("webhook.secret must be nonempty and at least 16 characters");
      if (/(change[-_ ]?me|replace[-_ ]?me|placeholder|example|your[-_ ]?secret|secret[-_ ]?here|todo)/i.test(secret)) {
        fail("webhook.secret still contains a placeholder; generate a unique secret");
      }
    }
    if (cfg.containerMount) {
      absolute(cfg.containerMount.host, "containerMount.host");
      absolute(cfg.containerMount.container, "containerMount.container");
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`preflight: ${error}`);
  process.exitCode = 1;
} else {
  console.error(`preflight: schema, token, provider paths, omp, ffmpeg, and ffprobe are valid for ${process.env.BRIDGE_SERVICE_USER}`);
}
NODE
then
  die "preflight failed; no unit was written"
fi


systemd_quote() {
  # systemd accepts C-style quoting; double percent to prevent specifier expansion.
  printf '%s' "$1" | sed 's/%/%%/g; s/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/'
}
sed_escape() { printf '%s' "$1" | sed 's/[\\&|]/\\&/g'; }
user_s=$(sed_escape "$service_user")
# WorkingDirectory is a path directive, not a shell/C-quoted command argument.
repo_s=$(sed_escape "$(printf '%s' "$repo" | sed 's/%/%%/g')")
node_s=$(sed_escape "$(systemd_quote "$node")")

render_unit() {
  sed \
    -e "s|@USER@|$user_s|g" \
    -e "s|@WORKDIR@|$repo_s|g" \
    -e "s|@NODE@|$node_s|g" \
    -e "s|@HOME_ENV@|$(sed_escape "$(systemd_quote "HOME=$service_home")")|g" \
    -e "s|@USER_ENV@|$(sed_escape "$(systemd_quote "USER=$service_user")")|g" \
    -e "s|@PATH_ENV@|$(sed_escape "$(systemd_quote "PATH=$service_path")")|g" \
    -e "s|@CONFIG_ENV@|$(sed_escape "$(systemd_quote "BRIDGE_CONFIG=$config")")|g" \
    "$template"
}

if [ "$print_unit" -eq 1 ]; then
  render_unit
  exit 0
fi
if [ "$check_only" -eq 1 ]; then
  echo "install: check-only complete; no files or services changed"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die "installation requires root; rerun with sudo (or use --check-only without sudo)"
command -v systemctl >/dev/null 2>&1 || die "systemctl is required for installation"
unit_dest=/etc/systemd/system/omp-video-bridge.service
tmp_unit=$(mktemp /etc/systemd/system/omp-video-bridge.service.tmp.XXXXXX)
trap 'rm -f "$tmp_unit"' EXIT HUP INT TERM
render_unit > "$tmp_unit"
chmod 0644 "$tmp_unit"
mv -f -- "$tmp_unit" "$unit_dest"
trap - EXIT HUP INT TERM
systemctl daemon-reload
echo "install: rendered $unit_dest for user=$service_user repo=$repo node=$node config=$config"

if [ "$enable" -eq 1 ]; then
  systemctl enable omp-video-bridge.service
fi
if [ "$start" -eq 1 ]; then
  systemctl start omp-video-bridge.service
fi
if [ "$restart" -eq 1 ]; then
  systemctl restart omp-video-bridge.service
fi
if [ "$enable" -eq 0 ] && [ "$start" -eq 0 ] && [ "$restart" -eq 0 ]; then
  echo "install: no service action requested; use systemctl start/enable explicitly after review"
fi
