import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

const script = resolve(__dirname, 'prune-old-images.sh');
const deploySource = readFileSync(resolve(__dirname, 'deploy-stack.sh'), 'utf8');
const upAllSource = readFileSync(resolve(__dirname, 'up-all.sh'), 'utf8');
const setupSource = readFileSync(resolve(__dirname, 'setup-vps.sh'), 'utf8');

const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
const iso = (secondsAgo: number) => new Date((now - secondsAgo) * 1000).toISOString();

type Image = { ref: string; id: string; ageHours: number };
type Container = { image: string; id: string; running: boolean };

// Fake docker backed by files: images.tsv (ref, id, created ISO),
// dangling.tsv (id, created ISO, tag count, digest count, image-role label) and containers.tsv
// (config image, image id, running 0/1). `tag` appends a row, `rmi` deletes
// one; every call is appended to calls.log.
const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
D="$FAKE_DOCKER_DIR"
echo "$*" >> "$D/calls.log"
case "$1" in
  ps)
    [ -f "$D/ps-fails" ] && exit 1
    if [ "$2" = "-a" ]; then awk -F'\\t' '{print "c" NR}' "$D/containers.tsv"
    else awk -F'\\t' '$3 == 1 {print "c" NR}' "$D/containers.tsv"; fi
    exit 0 ;;
  inspect)
    fmt="$3"; shift 3
    for c in "$@"; do
      line="$(sed -n "\${c#c}p" "$D/containers.tsv")"
      case "$fmt" in
        *Config.Image*) printf '%s %s\\n' "$(cut -f1 <<<"$line")" "$(cut -f2 <<<"$line")" ;;
        *) cut -f2 <<<"$line" ;;
      esac
    done
    exit 0 ;;
  images)
    if [ "$2" = --filter ]; then
      [ "$3" = dangling=true ] && [ "$4" = --filter ] || exit 2
      [ -f "$D/dangling-fails" ] && exit 1
      awk -F'\\t' -v want="$5" '"label=app.erp.image-role=" $5 == want {print $1}' "$D/dangling.tsv"
      exit 0
    fi
    awk -F'\\t' -v repo="$2" '{ split($1, a, ":"); if (a[1] == repo) print $1 }' "$D/images.tsv"
    exit 0 ;;
  image)
    if [ "$2" = inspect ] && [ "\${5#sha256:}" != "$5" ] && grep -q "^$5	" "$D/dangling.tsv"; then
      awk -F'\\t' -v id="$5" '$1 == id {print $2 "|" $3 "|" $4 "|" $5}' "$D/dangling.tsv"
      exit 0
    fi
    if [ "$2" = inspect ]; then
      line="$(awk -F'\\t' -v ref="$5" '$1 == ref' "$D/images.tsv")"
      [ -n "$line" ] || exit 1
      printf '%s|%s\\n' "$(cut -f2 <<<"$line")" "$(cut -f3 <<<"$line")"
      exit 0
    fi ;;
  tag)
    [ -f "$D/tag-fails" ] && exit 1
    created="$(awk -F'\\t' -v id="$2" '$2 == id {print $3; exit}' "$D/images.tsv")"
    # Docker moves an existing tag to the new image.
    awk -F'\\t' -v ref="$3" '$1 != ref' "$D/images.tsv" > "$D/images.tmp"
    mv "$D/images.tmp" "$D/images.tsv"
    printf '%s\\t%s\\t%s\\n' "$3" "$2" "$created" >> "$D/images.tsv"
    exit 0 ;;
  rmi)
    [ -f "$D/rmi-fails" ] && exit 1
    awk -F'\\t' -v ref="$2" '$1 != ref' "$D/images.tsv" > "$D/images.tmp"
    mv "$D/images.tmp" "$D/images.tsv"
    awk -F'\\t' -v id="$2" '$1 != id' "$D/dangling.tsv" > "$D/dangling.tmp"
    mv "$D/dangling.tmp" "$D/dangling.tsv"
    # Interleaving: a build starts right after the first removal.
    [ -f "$D/build-starts-on-rmi" ] && echo "docker build -t erp-backend:new /src/backend" > "$D/ps.txt"
    exit 0 ;;
esac
echo "unexpected docker call: $*" >&2
exit 2
`;

// Fake ps: prints ps.txt (the host process list) or fails with ps-fails.
const fakePs = `#!/usr/bin/env bash
D="$FAKE_DOCKER_DIR"
echo "ps $*" >> "$D/calls.log"
[ -f "$D/ps-list-fails" ] && exit 1
[ -f "$D/ps.txt" ] && cat "$D/ps.txt"
exit 0
`;

// role: value of the app.erp.image-role label; the backend build stage by default.
type Dangling = { id: string; ageHours: number; tags?: number; digests?: number; role?: string };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup(
  images: Image[],
  containers: Container[],
  releaseFiles: Record<string, string> = {},
  dangling: Dangling[] = [],
) {
  const dir = mkdtempSync(resolve(tmpdir(), 'prune-images-test-'));
  dirs.push(dir);
  const bin = resolve(dir, 'bin');
  const root = resolve(dir, 'root');
  mkdirSync(bin);
  mkdirSync(root);
  writeFileSync(resolve(bin, 'docker'), fakeDocker);
  chmodSync(resolve(bin, 'docker'), 0o755);
  writeFileSync(resolve(bin, 'ps'), fakePs);
  chmodSync(resolve(bin, 'ps'), 0o755);
  writeFileSync(
    resolve(dir, 'dangling.tsv'),
    dangling
      .map((d) => `${d.id}\t${iso(d.ageHours * HOUR)}\t${d.tags ?? 0}\t${d.digests ?? 0}\t${d.role ?? 'backend-build-stage'}\n`)
      .join(''),
  );
  writeFileSync(
    resolve(dir, 'images.tsv'),
    images.map((i) => `${i.ref}\t${i.id}\t${iso(i.ageHours * HOUR)}\n`).join(''),
  );
  setContainers(dir, containers);
  writeFileSync(resolve(dir, 'calls.log'), '');
  for (const [name, content] of Object.entries(releaseFiles)) writeFileSync(resolve(root, name), content);
  return { dir, root, lock: resolve(dir, 'images.lock') };
}

function setContainers(dir: string, containers: Container[]) {
  writeFileSync(
    resolve(dir, 'containers.tsv'),
    containers.map((c) => `${c.image}\t${c.id}\t${c.running ? 1 : 0}\n`).join(''),
  );
}

function run(dir: string, args: string[]) {
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${resolve(dir, 'bin')}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_DIR: dir,
      ERP_IMAGE_LOCK_FILE: resolve(dir, 'images.lock'),
    },
  });
  const calls = readFileSync(resolve(dir, 'calls.log'), 'utf8').trim().split('\n');
  return { ...result, rmi: calls.filter((c) => c.startsWith('rmi ')), calls };
}

const backend = (sha: string, ageHours: number): Image => ({
  ref: `erp-backend:${sha}`,
  id: `sha256:${sha}`,
  ageHours,
});
const runningBackend = (sha: string): Container => ({ image: `erp-backend:${sha}`, id: `sha256:${sha}`, running: true });

describe('prune-old-images.sh', () => {
  it('keeps used, newest, young, release-referenced and local images; removes the rest without -f', () => {
    const images = [
      backend('a1', 1), // newest
      backend('a2', 30),
      backend('a3', 40),
      backend('a4', 50), // outside keep=3, old → removed
      backend('a5', 60), // stopped container → kept
      backend('a6', 70), // release file → kept
      backend('a7', 80), // removed
      { ref: 'cad-service:c2', id: 'sha256:c2', ageHours: 50 },
      { ref: 'cad-service:c1', id: 'sha256:c1', ageHours: 100 },
      { ref: 'cad-service:c0', id: 'sha256:c0', ageHours: 200 },
      { ref: 'cad-service:old', id: 'sha256:c9', ageHours: 300 }, // removed
      { ref: 'cad-service:local', id: 'sha256:c8', ageHours: 400 }, // local → kept
      { ref: 'cad-service:c8sha', id: 'sha256:c8', ageHours: 400 }, // same image as local → kept
      { ref: 'other-project:x', id: 'sha256:x', ageHours: 900 }, // foreign → never listed
    ];
    const { dir, root } = setup(images, [{ image: 'erp-backend:a5', id: 'sha256:a5', running: false }], {
      'backend-release.previous.env': 'BACKEND_BUILD_IMAGE=erp-backend:a6\nBACKEND_BUILD_SHA=a6\n',
      'unrelated.env': 'BACKEND_BUILD_IMAGE=erp-backend:a7\n',
    });
    const result = run(dir, ['--root', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi.sort()).toEqual(['rmi cad-service:old', 'rmi erp-backend:a4', 'rmi erp-backend:a7']);
    expect(result.calls.some((c) => / prune/.test(` ${c}`))).toBe(false);
    expect(result.stdout).toContain('keep   erp-backend:a5 (used by a container)');
    expect(result.stdout).toContain('keep   erp-backend:a6 (referenced by a release file)');
    expect(result.stdout).toContain('keep   cad-service:c8sha (local tag)');
  });

  it('keeps images younger than the age window even outside the newest N', () => {
    const images = [backend('b1', 1), backend('b2', 2), backend('b3', 3), backend('b4', 4), backend('b5', 30)];
    const { dir, root } = setup(images, []);
    const result = run(dir, ['--root', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual(['rmi erp-backend:b5']);
    expect(result.stdout).toContain('keep   erp-backend:b4 (younger than 24h)');
  });

  it('keeps the pre-deploy image via a daemon-side pin tag, whatever root the later cleanup uses', () => {
    // Old image p0 is running and outside the newest 3 once newer builds exist.
    const images = [backend('p3', 30), backend('p2', 40), backend('p1', 50), backend('p0', 100)];
    const { dir, root } = setup(images, [runningBackend('p0'), { image: 'traefik:v3', id: 'sha256:t', running: true }]);
    const pin = run(dir, ['--pin-running']);
    expect(pin.status, pin.stderr).toBe(0);
    expect(pin.calls.filter((c) => c.startsWith('tag '))).toEqual([expect.stringMatching(/^tag sha256:p0 erp-backend:pinned-\d+-p0$/)]);
    // Deploy replaces p0's container with p3; cleanup runs from a different root.
    setContainers(dir, [runningBackend('p3')]);
    const otherRoot = resolve(dir, 'other-root');
    mkdirSync(otherRoot);
    const result = run(dir, ['--root', otherRoot]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual([]);
    expect(result.stdout).toContain('keep   erp-backend:p0 (pinned before a deploy)');
  });

  it('removes expired pin tags together with their image', () => {
    const expired = now - 8 * 86400;
    const images = [
      backend('q3', 30),
      backend('q2', 40),
      backend('q1', 50),
      backend('q0', 100),
      { ref: `erp-backend:pinned-${expired}-q0`, id: 'sha256:q0', ageHours: 100 },
    ];
    const { dir, root } = setup(images, []);
    const result = run(dir, ['--root', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi.sort()).toEqual([`rmi erp-backend:pinned-${expired}-q0`, 'rmi erp-backend:q0']);
  });

  it('pins two running images of one repo under distinct tags; both survive replacement', () => {
    const images = [backend('s4', 30), backend('s3', 40), backend('s2', 50), backend('s1', 100), backend('s0', 110)];
    const { dir, root } = setup(images, [runningBackend('s0'), runningBackend('s1')]);
    const pin = run(dir, ['--pin-running']);
    expect(pin.status, pin.stderr).toBe(0);
    expect(pin.calls.filter((c) => c.startsWith('tag ')).map((c) => c.split(' ')[2].replace(/pinned-\d+-/, 'pinned-'))).toEqual([
      'erp-backend:pinned-s0',
      'erp-backend:pinned-s1',
    ]);
    // Replace s0 first, then s1; cleanup from another root each time.
    const otherRoot = resolve(dir, 'other-root');
    mkdirSync(otherRoot);
    for (const containers of [[runningBackend('s4'), runningBackend('s1')], [runningBackend('s4')]]) {
      setContainers(dir, containers);
      const cleanup = run(dir, ['--root', otherRoot]);
      expect(cleanup.status, cleanup.stderr).toBe(0);
      expect(cleanup.rmi).toEqual([]);
      expect(cleanup.stdout).toContain('keep   erp-backend:s0 (pinned before a deploy)');
    }
    expect(run(dir, ['--root', otherRoot]).stdout).toContain('keep   erp-backend:s1 (pinned before a deploy)');
  });

  it('fails the pin step when running containers cannot be listed', () => {
    const { dir } = setup([backend('u0', 100)], [runningBackend('u0')]);
    writeFileSync(resolve(dir, 'ps-fails'), '');
    const result = run(dir, ['--pin-running']);
    expect(result.status).not.toBe(0);
    expect(result.calls.some((c) => c.startsWith('tag '))).toBe(false);
  });

  it('fails the pin step when docker tag fails', () => {
    const { dir } = setup([backend('r0', 100)], [runningBackend('r0')]);
    writeFileSync(resolve(dir, 'tag-fails'), '');
    expect(run(dir, ['--pin-running']).status).not.toBe(0);
  });

  it('skips cleanup while a deploy holds the shared image lock', async () => {
    const { dir, root, lock } = setup([backend('l1', 100)], []);
    const holder = spawn('flock', ['-s', lock, 'sleep', '5']);
    try {
      for (let i = 0; i < 50 && !existsSync(lock); i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      const result = run(dir, ['--root', root, '--keep', '0', '--min-age-hours', '0']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('skipping cleanup');
      expect(result.rmi).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  it('fails closed when a release file cannot be read', () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const { dir, root } = setup([backend('f1', 100)], [], {
      'backend-release.previous.env': 'BACKEND_BUILD_IMAGE=erp-backend:f1\n',
    });
    chmodSync(resolve(root, 'backend-release.previous.env'), 0o000);
    const result = run(dir, ['--root', root, '--keep', '0', '--min-age-hours', '0']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to remove anything');
    expect(result.rmi).toEqual([]);
  });

  it('fails closed when the runtime root is missing', () => {
    const { dir } = setup([backend('m1', 100)], []);
    const result = run(dir, ['--root', resolve(dir, 'missing'), '--keep', '0']);
    expect(result.status).not.toBe(0);
    expect(result.rmi).toEqual([]);
  });

  it('dry-run removes nothing', () => {
    const { dir, root } = setup([backend('d1', 100), backend('d2', 200)], []);
    const result = run(dir, ['--root', root, '--dry-run', '--keep', '0', '--min-age-hours', '0']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual([]);
    expect(result.stdout).toContain('remove erp-backend:d1 (dry-run)');
  });

  it('reports a refused rmi and still exits 0', () => {
    const { dir, root } = setup([backend('e1', 100)], []);
    writeFileSync(resolve(dir, 'rmi-fails'), '');
    const result = run(dir, ['--root', root, '--keep', '0']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('skip   erp-backend:e1 (docker rmi refused)');
  });

  it('rejects invalid arguments', () => {
    const { dir, root } = setup([], []);
    expect(run(dir, ['--root', root, '--keep', 'x']).status).not.toBe(0);
  });

  it('--dangling removes old locally built untagged images and keeps young, pulled and used ones', () => {
    const dangling: Dangling[] = [
      { id: 'sha256:n1old', ageHours: 30 }, // stage leftover → removed
      { id: 'sha256:n2old', ageHours: 200 }, // removed
      { id: 'sha256:n3young', ageHours: 2 }, // younger than 24h → kept
      { id: 'sha256:n4pulled', ageHours: 500, digests: 1 }, // pulled by digest → kept
      { id: 'sha256:n5used', ageHours: 500 }, // stopped container → kept
      { id: 'sha256:n6tagged', ageHours: 500, tags: 1 }, // tagged meanwhile → kept
    ];
    const images = [backend('g1', 1), backend('g2', 30), backend('g3', 40), backend('g4', 50)];
    const { dir, root } = setup(images, [{ image: 'sha256:n5used', id: 'sha256:n5used', running: false }], {}, dangling);
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi.sort()).toEqual(['rmi erp-backend:g4', 'rmi sha256:n1old', 'rmi sha256:n2old']);
    expect(result.calls.some((c) => / -f( |$)/.test(c) && c.startsWith('rmi'))).toBe(false);
    expect(result.stdout).toContain('keep   <none>@n3young (younger than 24h)');
    expect(result.stdout).toContain('keep   <none>@n4pulled (pulled from a registry)');
    expect(result.stdout).toContain('keep   <none>@n5used (used by a container)');
    expect(result.stdout).toContain('keep   <none>@n6tagged (tagged meanwhile)');
    expect(result.stdout).toContain('removed 2 dangling image(s)');
  });

  it('--dangling never touches untagged images that are not backend build stages', () => {
    const dangling: Dangling[] = [
      { id: 'sha256:other', ageHours: 300, role: '' }, // another project's leftover → not even listed
      { id: 'sha256:mine', ageHours: 300 },
    ];
    const { dir, root } = setup([], [], {}, dangling);
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual(['rmi sha256:mine']);
    expect(result.calls).toContain('images --filter dangling=true --filter label=app.erp.image-role=backend-build-stage --quiet --no-trunc');
  });

  it('--dangling re-checks the label on inspection', () => {
    // A listing that ignored the label filter must still not lead to removal.
    const { dir, root } = setup([], [], {}, [{ id: 'sha256:relabeled', ageHours: 300, role: 'backend-build-stage' }]);
    writeFileSync(
      resolve(dir, 'dangling.tsv'),
      readFileSync(resolve(dir, 'dangling.tsv'), 'utf8').replace(/\tbackend-build-stage\n$/, '\tother-role\n'),
    );
    writeFileSync(resolve(dir, 'bin', 'docker'), fakeDocker.replace('"label=app.erp.image-role=" $5 == want', '1'));
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual([]);
    expect(result.stdout).toContain('keep   <none>@relabeled (not a backend build stage)');
  });

  it('--dangling stops as soon as an image build starts mid-cleanup', () => {
    const dangling: Dangling[] = [
      { id: 'sha256:a-first', ageHours: 300 },
      { id: 'sha256:b-second', ageHours: 300 },
    ];
    const { dir, root } = setup([], [], {}, dangling);
    writeFileSync(resolve(dir, 'build-starts-on-rmi'), '');
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual(['rmi sha256:a-first']);
    expect(result.stdout).toContain('an image build started; stopping dangling cleanup');
    expect(result.stdout).toContain('removed 1 dangling image(s)');
  });

  it('backend Dockerfile labels the build stage only, not the runtime image', () => {
    const dockerfile = readFileSync(resolve(__dirname, '../backend/Dockerfile'), 'utf8');
    const buildAt = dockerfile.indexOf('FROM deps AS build');
    const labelAt = dockerfile.indexOf('LABEL app.erp.image-role="backend-build-stage"');
    const runtimeAt = dockerfile.indexOf('AS runtime');
    expect(buildAt).toBeGreaterThan(0);
    expect(labelAt).toBeGreaterThan(buildAt);
    expect(labelAt).toBeLessThan(runtimeAt);
    expect(dockerfile.slice(runtimeAt)).not.toContain('app.erp.image-role');
    expect(dockerfile.slice(runtimeAt)).toMatch(/^AS runtime\n/);
  });

  it('never touches dangling images without --dangling', () => {
    const { dir, root } = setup([backend('h1', 100)], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    const result = run(dir, ['--root', root, '--keep', '0', '--min-age-hours', '0']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual(['rmi erp-backend:h1']);
    expect(result.calls.some((c) => c.startsWith('images --filter dangling=true') || c === 'ps -ww -eo args=')).toBe(false);
  });

  it.each([
    'docker build --cpuset-cpus 1 -t erp-backend:abc /src/backend',
    '/usr/bin/docker build -t x .',
    '/usr/libexec/docker/cli-plugins/docker-buildx buildx build --load .',
    'docker compose -f a.yml up -d --build backend',
    '/usr/libexec/docker/cli-plugins/docker-compose compose build backend',
  ])('skips dangling cleanup while an image build runs: %s', (proc) => {
    const { dir, root } = setup([backend('k1', 100)], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    writeFileSync(resolve(dir, 'ps.txt'), `bash\n${proc}\nsleep 5\n`);
    const result = run(dir, ['--root', root, '--keep', '0', '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('an image build is running; skipping dangling cleanup');
    expect(result.rmi).toEqual(['rmi erp-backend:k1']);
  });

  it('does not mistake other docker commands for a build', () => {
    const { dir, root } = setup([], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    writeFileSync(
      resolve(dir, 'ps.txt'),
      ['docker builder prune -f', 'node stage-deploy.cjs build abc', 'docker logs -f backend', 'vim build'].join('\n') + '\n',
    );
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual(['rmi sha256:old']);
  });

  it('skips dangling cleanup when the process list cannot be read', () => {
    const { dir, root } = setup([], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    writeFileSync(resolve(dir, 'ps-list-fails'), '');
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('skipping dangling cleanup');
    expect(result.rmi).toEqual([]);
  });

  it('fails closed when dangling images cannot be listed', () => {
    const { dir, root } = setup([], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    writeFileSync(resolve(dir, 'dangling-fails'), '');
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status).not.toBe(0);
    expect(result.rmi).toEqual([]);
  });

  it('--dangling with --dry-run removes nothing', () => {
    const { dir, root } = setup([], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    const result = run(dir, ['--root', root, '--dangling', '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.rmi).toEqual([]);
    expect(result.stdout).toContain('remove <none>@old (dry-run)');
  });

  it('reports a refused dangling rmi and still exits 0', () => {
    const { dir, root } = setup([], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    writeFileSync(resolve(dir, 'rmi-fails'), '');
    const result = run(dir, ['--root', root, '--dangling']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('skip   <none>@old (docker rmi refused)');
  });

  it('skips dangling cleanup too while a deploy holds the shared image lock', async () => {
    const { dir, root, lock } = setup([], [], {}, [{ id: 'sha256:old', ageHours: 300 }]);
    const holder = spawn('flock', ['-s', lock, 'sleep', '5']);
    try {
      for (let i = 0; i < 50 && !existsSync(lock); i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      const result = run(dir, ['--root', root, '--dangling']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('skipping cleanup');
      expect(result.rmi).toEqual([]);
    } finally {
      holder.kill();
    }
  });

  it('deploy scripts never pass --dangling (production behaviour unchanged)', () => {
    for (const source of [deploySource, upAllSource, setupSource]) expect(source).not.toContain('--dangling');
  });

  it('deploy-stack.sh pins under the shared lock before replacing containers and prunes after releasing it', () => {
    const lockAt = deploySource.indexOf('flock -s 8');
    const pinAt = deploySource.indexOf('prune-old-images.sh" --pin-running');
    const upAt = deploySource.indexOf('docker_compose "${up_args[@]}"');
    const releaseAt = deploySource.indexOf('exec 8>&-');
    const pruneAt = deploySource.indexOf('prune-old-images.sh" --root "$PROJECT_DIR" \\\n    || log "WARN');
    expect(deploySource).toContain('exec 8>>"${ERP_IMAGE_LOCK_FILE:-/tmp/erp-images.lock}"');
    expect(lockAt).toBeGreaterThan(0);
    expect(lockAt).toBeLessThan(pinAt);
    expect(pinAt).toBeLessThan(deploySource.indexOf('docker_compose build'));
    expect(upAt).toBeLessThan(releaseAt);
    expect(releaseAt).toBeLessThan(pruneAt);
    expect(deploySource).toContain('--pin-running \\\n  || fail "could not pin');
  });

  it('up-all.sh pins before up/rebuild/provision and prunes best-effort after rebuild/provision', () => {
    expect(upAllSource).toContain('exec 8>>"${ERP_IMAGE_LOCK_FILE:-/tmp/erp-images.lock}"');
    expect(upAllSource.match(/^\s+begin_image_deploy$/gm)).toHaveLength(3);
    expect(upAllSource.match(/^\s+prune_old_images$/gm)).toHaveLength(2);
    expect(upAllSource).toMatch(/prune_old_images\(\) \{\n\s+exec 8>&-/);
    expect(upAllSource).toMatch(/prune-old-images\.sh" --root "\$ROOT" \\\n\s+\|\| warn /);
    expect(upAllSource).toContain('--pin-running \\\n    || die "could not pin');
  });

  it('setup-vps.sh holds the shared image lock from build until start, then prunes', () => {
    const lockAt = setupSource.indexOf('exec 8>>"${ERP_IMAGE_LOCK_FILE:-/tmp/erp-images.lock}"');
    const buildAt = setupSource.indexOf('run_deploy build\n');
    const startAt = setupSource.indexOf('run_deploy start\n');
    const releaseAt = setupSource.indexOf('exec 8>&-');
    const pruneAt = setupSource.indexOf('prune-old-images.sh" --root "$PROJECT_DIR"');
    expect(lockAt).toBeGreaterThan(0);
    expect(lockAt).toBeLessThan(buildAt);
    expect(buildAt).toBeLessThan(startAt);
    expect(startAt).toBeLessThan(releaseAt);
    expect(releaseAt).toBeLessThan(pruneAt);
  });
});
