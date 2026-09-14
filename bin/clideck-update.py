#!/usr/bin/env python3
"""Prepare, apply and roll back local v2 updates. Identical workflow on host and VM."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    print('+', ' '.join(str(a) for a in args), flush=True)
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def json_file(path):
    return json.loads(Path(path).read_text())


def save(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fingerprint(root):
    result = hashlib.sha256()
    for path in sorted(Path(root).rglob('*')):
        relative = path.relative_to(root)
        if any(part in ('node_modules', '__pycache__', '.git') for part in relative.parts):
            continue
        if path.is_file():
            result.update(str(relative).encode())
            result.update(digest(path).encode())
    return result.hexdigest()


def health(url):
    with urllib.request.urlopen(url.rstrip('/')+'/api/health', timeout=5) as response:
        return json.load(response)


def wait_health(state, version):
    last = None
    for _ in range(30):
        try:
            last = health(state['url'])
            if last.get('version') == version and last.get('protocol') == 'fork-v6':
                return last
        except (OSError, ValueError) as error:
            last = str(error)
        time.sleep(1)
    raise RuntimeError(f'Expected {version}/fork-v6; health: {last}')


def service(state, *args):
    return run(['systemctl', '--user', *args, state['service']])


def assert_service(state):
    transient = subprocess.check_output(['systemctl', '--user', 'show', state['service'], '-p', 'Transient', '--value'], text=True).strip()
    if transient == 'yes':
        raise RuntimeError('The updater requires a persistent service; transient units disappear when stopped.')
    pid = subprocess.check_output(['systemctl', '--user', 'show', state['service'], '-p', 'MainPID', '--value'], text=True).strip()
    lock = json_file(Path(state['data'])/'server.lock')
    if pid != str(lock['pid']):
        raise RuntimeError('Selected service does not own the data directory server lock.')
    command = subprocess.check_output(['systemctl', '--user', 'show', state['service'], '-p', 'ExecStart', '--value'], text=True)
    if str(Path(state['installed'])/'bin/clideck.js') not in command:
        raise RuntimeError('Selected service does not run the selected installed package.')


def bin_directory(installed):
    modules = Path(installed).parent
    if modules.name != 'node_modules':
        raise RuntimeError('Installed package must be in a node_modules directory.')
    prefix = modules.parent.parent if modules.parent.name == 'lib' else modules.parent
    return prefix/'bin'


def capture_bins(installed, old, new):
    directory = bin_directory(installed)
    result = {}
    for name in set(old.get('bin', {})) | set(new.get('bin', {})):
        if Path(name).name != name:
            raise RuntimeError('Invalid executable name in package manifest.')
        target = directory/name
        if target.is_symlink():
            resolved = target.resolve()
            if not resolved.is_relative_to(installed):
                raise RuntimeError(f'Executable collision: {target}')
            result[name] = os.readlink(target)
        elif target.exists():
            raise RuntimeError(f'Executable collision: {target}')
        else:
            result[name] = None
    return result


def install_bins(state, restore=False):
    directory = bin_directory(state['installed'])
    directory.mkdir(parents=True, exist_ok=True)
    desired = state['bin_links'] if restore else {
        name: str(Path(state['installed'])/value)
        for name, value in json_file(Path(state['installed'])/'package.json').get('bin', {}).items()}
    for name in state['bin_links']:
        target = directory/name
        if target.is_symlink():
            if not target.resolve().is_relative_to(state['installed']):
                raise RuntimeError(f'Executable changed during update: {target}')
            target.unlink()
        elif target.exists():
            raise RuntimeError(f'Executable changed during update: {target}')
        if desired.get(name):
            target.symlink_to(desired[name])


def check_sessions(state, mode, output=None):
    run([state['node'], Path(state['candidate'])/'src/fork/update-check.js', mode,
         state['data'], state['url'], output or Path(state['run'])/'before.json',
         state.get('caller', '') if mode == 'capture' else ''])


def snapshot(data, destination):
    def include(info):
        parts = Path(info.name).parts
        return None if len(parts) > 1 and parts[1] in ('plugin-data', 'server.lock') else info
    with tarfile.open(destination, 'w:gz') as archive:
        archive.add(data, arcname='data', filter=include)


def restore_data(state):
    data = Path(state['data'])
    # Keep failed-version state for recovery before restoring the previous registry.
    snapshot(data, Path(state['run'])/'failed-data.tar.gz')
    staging = Path(state['run'])/'restore-data'
    staging.mkdir(exist_ok=True)
    with tarfile.open(Path(state['run'])/'before-data.tar.gz') as archive:
        archive.extractall(staging, filter='data')
    shutil.copytree(staging/'data', data, dirs_exist_ok=True)
    (data/'server.lock').unlink(missing_ok=True)


def verify(state, version):
    wait_health(state, version)
    check_sessions(state, 'resume')
    assert_service(state)
    installed = Path(state['installed'])
    with urllib.request.urlopen(state['url'].rstrip('/')+'/plugins/git-diff/public/index.html', timeout=5) as response:
        served = hashlib.sha256(response.read()).hexdigest()
    if served != digest(installed/'plugins/git-diff/public/index.html'):
        raise RuntimeError('Served Git workspace does not match the installed release.')
    config = json_file(Path(state['data'])/'config.json')
    voice = config.get('plugins', {}).get('voice-input', {})
    if voice.get('enabled') and voice.get('settings', {}).get('backend') == 'local':
        run([state['node'], Path(state['candidate'])/'bin/clideck-voice-setup.js', '--check',
             '--voice-dir', Path(state['data'])/'plugin-data/voice-input'])
    restarts = subprocess.check_output(['systemctl','--user','show',state['service'],'-p','NRestarts','--value'],text=True).strip()
    if restarts != '0':
        raise RuntimeError(f'Engine restarted unexpectedly {restarts} times.')


def rollback(state):
    service(state, 'stop')
    restore_data(state)
    installed = Path(state['installed'])
    shutil.rmtree(installed)
    shutil.copytree(Path(state['run'])/'previous-package', installed, symlinks=True)
    install_bins(state, restore=True)
    service(state, 'start')
    verify(state, state['old_version'])
    save(Path(state['run'])/'result.json', {'status':'rolled-back','version':state['old_version']})


def execute(state, roll_back=False):
    run_dir = Path(state['run'])
    with (Path(state['data'])/'update.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if roll_back:
            assert_service(state)
            check_sessions(state, 'capture', run_dir/'rollback-live.json')
            # Never overwrite conversations created since the upgrade.
            current = json_file(run_dir/'rollback-live.json')
            before = json_file(run_dir/'before.json')
            if (sorted(current['registryIds']) != sorted(before['registryIds'])
                    or sorted(current['native'], key=lambda s:s['id']) != sorted(before['native'], key=lambda s:s['id'])):
                raise RuntimeError('Native inventory changed since deployment; inspect before rolling back.')
            rollback(state)
            return
        if fingerprint(state['installed']) != state['old_fingerprint']:
            raise RuntimeError('Installed code changed after preflight; prepare the update again.')
        if fingerprint(state['candidate']) != state['candidate_fingerprint']:
            raise RuntimeError('Preflighted candidate changed; prepare the update again.')
        if digest(run_dir/'release.tgz') != state['sha256']:
            raise RuntimeError('Release artifact changed after preflight.')
        assert_service(state)
        check_sessions(state, 'capture')
        stopped = False
        try:
            service(state, 'stop')
            stopped = True
            snapshot(state['data'], run_dir/'before-data.tar.gz')
            # Install the already-preflighted candidate without a second registry resolution.
            shutil.rmtree(state['installed'])
            shutil.copytree(state['candidate'], state['installed'], symlinks=True)
            install_bins(state)
            service(state, 'start')
            verify(state, state['version'])
        except BaseException:
            if stopped and (run_dir/'before-data.tar.gz').exists():
                print('Verification failed; rolling back.', flush=True)
                rollback(state)
            elif stopped:
                service(state, 'start')
            raise
        save(run_dir/'result.json', {'status':'complete','version':state['version'], 'verified_at':datetime.datetime.now().astimezone().isoformat()})
        print('Upgrade complete. Rollback and evidence:', run_dir, flush=True)


def launch(state, roll_back=False):
    name = 'clideck-update-'+Path(state['run']).name+('-rollback' if roll_back else '')
    args = ['systemd-run','--user','--unit='+name,
            '--property=WorkingDirectory='+state['run'],
            '--property=UnsetEnvironment=CLIDECK_SESSION_ID CLIDECK_NEXT_SESSION_ID',
            '--property=StandardOutput=append:'+str(Path(state['run'])/'update.log'),
            '--property=StandardError=append:'+str(Path(state['run'])/'update.log'),
            '--setenv=PATH='+state['path'], sys.executable,
            str(Path(state['candidate'])/'bin/clideck-update.py'),
            '--execute',state['run']]
    if roll_back:
        args.append('--rollback-worker')
    run(args)
    print('Independent installer started:', name+'.service', '\nResults:', Path(state['run'])/'result.json')


def prepare(args):
    installed = Path(args.installed_root or ROOT).resolve()
    old = json_file(installed/'package.json')
    if old.get('name') != 'clideck' or not old['version'].startswith('2.'):
        raise RuntimeError('Only an existing CliDeck v2 installation can use this updater.')
    data = Path(args.data_dir).expanduser().resolve()
    lock = json_file(data/'server.lock')
    url = args.url or lock['url']
    current = health(url)
    if current.get('version') != old['version'] or current.get('protocol') != 'fork-v6':
        raise RuntimeError('The running engine does not match the selected installed package.')
    package = Path(args.package).resolve()
    if len(args.sha256 or '') != 64 or digest(package) != args.sha256.lower():
        raise RuntimeError('Release SHA-256 does not match.')
    node = Path(args.node or shutil.which('node') or '').resolve()
    npm = node.parent/'npm'
    if not node.is_file() or not npm.is_file():
        raise RuntimeError('Select the installed Node executable with --node; adjacent npm is required.')
    os.environ['PATH'] = str(node.parent)+os.pathsep+os.environ.get('PATH','/usr/bin:/bin')
    stamp = datetime.datetime.now().astimezone().strftime('%Y%m%dT%H%M%S')+'-'+os.urandom(3).hex()
    run_dir = Path.home()/'.local/state/clideck-builds/updates'/stamp
    run_dir.mkdir(parents=True, mode=0o700)
    shutil.copy2(package,run_dir/'release.tgz')
    run([node,npm,'install','--prefix',run_dir/'candidate','--omit=dev','--no-audit','--no-fund',run_dir/'release.tgz'])
    candidate = run_dir/'candidate/node_modules/clideck'
    new = json_file(candidate/'package.json')
    if new.get('name') != 'clideck' or not new['version'].startswith('2.'):
        raise RuntimeError('Not a CliDeck v2 release.')
    # npm may hoist dependencies to the staging prefix. Materialize them inside
    # the candidate so the exact tested tree can be copied into the global slot.
    modules = candidate/'node_modules'
    modules.mkdir(exist_ok=True)
    for dependency in (run_dir/'candidate/node_modules').iterdir():
        if dependency.name == 'clideck' or dependency.name.startswith('.'):
            continue
        if dependency.is_dir():
            shutil.copytree(dependency,modules/dependency.name,dirs_exist_ok=True,symlinks=True)
    run([node,candidate/'src/fork/package-check.js',candidate])
    state = {'run':str(run_dir),'installed':str(installed),'candidate':str(candidate),'data':str(data),
             'url':url,'service':args.service,'node':str(node),'path':os.environ['PATH'],
             'version':new['version'],'old_version':old['version'],'sha256':args.sha256.lower(),
             'old_fingerprint':fingerprint(installed),'candidate_fingerprint':fingerprint(candidate),'bin_links':capture_bins(installed,old,new),'caller':os.environ.get('CLIDECK_SESSION_ID','')}
    assert_service(state)
    check_sessions(state,'capture')
    # An update must not need to download speech dependencies during startup.
    config = json_file(data/'config.json')
    voice = config.get('plugins',{}).get('voice-input',{})
    if voice.get('enabled') and voice.get('settings',{}).get('backend') == 'local':
        run([node,candidate/'bin/clideck-voice-setup.js','--check','--voice-dir',data/'plugin-data/voice-input'])
    shutil.copytree(installed,run_dir/'previous-package',symlinks=True)
    if fingerprint(run_dir/'previous-package') != state['old_fingerprint'] or fingerprint(installed) != state['old_fingerprint']:
        raise RuntimeError('Installed package changed during backup; prepare again.')
    save(run_dir/'state.json',state)
    print(f"Prepared {old['version']} -> {new['version']}. Existing service, bind address and origins are preserved.")
    print('Evidence:',run_dir)
    if args.apply:
        launch(state)
    return state


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package',nargs='?')
    parser.add_argument('--sha256')
    parser.add_argument('--apply',action='store_true',help='Start the independent installer after preflight; default is check only.')
    parser.add_argument('--installed-root')
    parser.add_argument('--data-dir',default=str(Path.home()/'.clideck-next'))
    parser.add_argument('--url')
    parser.add_argument('--service',default='clideck.service')
    parser.add_argument('--node')
    parser.add_argument('--rollback',metavar='RUN_DIRECTORY')
    parser.add_argument('--execute',help=argparse.SUPPRESS)
    parser.add_argument('--rollback-worker',action='store_true',help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.execute:
        if not os.environ.get('INVOCATION_ID') or os.environ.get('CLIDECK_SESSION_ID'):
            raise RuntimeError('Apply must run in the independent systemd installer.')
        execute(json_file(Path(args.execute)/'state.json'), args.rollback_worker)
    elif args.rollback:
        launch(json_file(Path(args.rollback)/'state.json'),True)
    elif args.package:
        prepare(args)
    else:
        parser.error('Supply a release tarball and --sha256, or --rollback RUN_DIRECTORY.')


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        if '--execute' in sys.argv:
            try:
                directory = Path(sys.argv[sys.argv.index('--execute') + 1])
                result = json_file(directory/'result.json') if (directory/'result.json').exists() else {'status':'failed'}
                result['error'] = str(error)
                save(directory/'result.json', result)
            except (OSError, ValueError, IndexError):
                pass
        print('Update failed:',error,file=sys.stderr)
        sys.exit(1)
