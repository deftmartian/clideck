import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('updater', Path(__file__).resolve().parents[2]/'bin/clideck-update.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class UpdaterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        installed = root/'prefix/lib/node_modules/clideck'
        candidate = root/'candidate'
        run = root/'run'
        data = root/'data'
        for folder in (installed, candidate, run, data):
            folder.mkdir(parents=True)
        for folder, version, bins in ((installed, '2.1.1-old', {'clideck':'bin/clideck.js'}),
                                      (candidate, '2.1.1-new', {'clideck':'bin/clideck.js', 'clideck-update':'bin/update.py'})):
            (folder/'package.json').write_text(json.dumps({'name':'clideck','version':version,'bin':bins}))
            (folder/'bin').mkdir()
            for target in bins.values():
                (folder/target).write_text(version)
        u.bin_directory(installed).mkdir()
        (u.bin_directory(installed)/'clideck').symlink_to(installed/'bin/clideck.js')
        (data/'config.json').write_text('{"original":true}')
        (data/'plugin-data').mkdir()
        (data/'plugin-data/keep').write_text('runtime state')
        (run/'release.tgz').write_bytes(b'fixture')
        u.shutil.copytree(installed,run/'previous-package',symlinks=True)
        self.state = {'run':str(run),'data':str(data),'installed':str(installed),'candidate':str(candidate),
                      'old_version':'2.1.1-old','version':'2.1.1-new',
                      'old_fingerprint':u.fingerprint(installed),'candidate_fingerprint':u.fingerprint(candidate),
                      'sha256':u.digest(run/'release.tgz'),
                      'bin_links':u.capture_bins(installed,u.json_file(installed/'package.json'),u.json_file(candidate/'package.json'))}

    def test_success_installs_verified_tree_and_new_cli_links(self):
        with patch.object(u,'assert_service'), patch.object(u,'check_sessions'), patch.object(u,'service') as service, patch.object(u,'verify'):
            u.execute(self.state)
        installed = Path(self.state['installed'])
        self.assertEqual(u.json_file(installed/'package.json')['version'],'2.1.1-new')
        self.assertTrue((u.bin_directory(installed)/'clideck-update').is_symlink())
        self.assertEqual(u.json_file(Path(self.state['run'])/'result.json')['status'],'complete')
        self.assertEqual([call.args[1] for call in service.call_args_list],['stop','start'])

    def test_failed_verification_restores_package_registry_and_executable_links(self):
        def verify(state, version):
            if version == '2.1.1-new':
                (Path(state['data'])/'config.json').write_text('{"new":true}')
                raise RuntimeError('injected readiness failure')
        with patch.object(u,'assert_service'), patch.object(u,'check_sessions'), patch.object(u,'service') as service, patch.object(u,'verify',side_effect=verify):
            with self.assertRaisesRegex(RuntimeError,'injected readiness'):
                u.execute(self.state)
        installed = Path(self.state['installed'])
        self.assertEqual(u.json_file(installed/'package.json')['version'],'2.1.1-old')
        self.assertEqual(u.json_file(Path(self.state['data'])/'config.json'),{'original':True})
        self.assertEqual((Path(self.state['data'])/'plugin-data/keep').read_text(),'runtime state')
        self.assertFalse((u.bin_directory(installed)/'clideck-update').exists())
        self.assertEqual(u.json_file(Path(self.state['run'])/'result.json')['status'],'rolled-back')
        self.assertTrue((Path(self.state['run'])/'failed-data.tar.gz').exists())
        self.assertEqual([call.args[1] for call in service.call_args_list],['stop','start','stop','start'])

    def test_busy_conversations_abort_before_stopping(self):
        with patch.object(u,'assert_service'), patch.object(u,'check_sessions',side_effect=RuntimeError('working')), patch.object(u,'service') as service:
            with self.assertRaisesRegex(RuntimeError,'working'):
                u.execute(self.state)
            service.assert_not_called()

    def test_changed_package_or_candidate_aborts_before_stopping(self):
        for field in ('installed','candidate'):
            with self.subTest(field=field):
                extra=Path(self.state[field])/'changed';extra.write_text('changed')
                with patch.object(u,'service') as service:
                    with self.assertRaisesRegex(RuntimeError,'changed'):
                        u.execute(self.state)
                    service.assert_not_called()
                extra.unlink()

    def test_transient_service_is_rejected_before_cutover(self):
        with patch.object(u.subprocess,'check_output',return_value='yes\n'):
            with self.assertRaisesRegex(RuntimeError,'persistent service'):
                u.assert_service({'service':'transient.service'})

    def test_manual_rollback_refuses_new_dormant_panes(self):
        run=Path(self.state['run'])
        u.save(run/'before.json',{'registryIds':['original'],'native':[]})
        def capture(*args):
            u.save(run/'rollback-live.json',{'registryIds':['original','new-pane'],'native':[]})
        with patch.object(u,'assert_service'), patch.object(u,'check_sessions',side_effect=capture), patch.object(u,'service') as service:
            with self.assertRaisesRegex(RuntimeError,'inventory changed'):
                u.execute(self.state,roll_back=True)
            service.assert_not_called()

    def test_unrelated_executable_cannot_be_overwritten(self):
        installed=Path(self.state['installed'])
        (u.bin_directory(installed)/'clideck-update').write_text('unrelated command')
        with self.assertRaisesRegex(RuntimeError,'collision'):
            u.capture_bins(installed,u.json_file(installed/'package.json'),u.json_file(Path(self.state['candidate'])/'package.json'))


if __name__ == '__main__':
    unittest.main()
