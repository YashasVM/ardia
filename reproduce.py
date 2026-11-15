import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path[:0] = [str(Path.cwd() / 'apps/cli'), str(Path.cwd() / 'apps/cli/tests')]
from ardia_cli import caller, control, endpoint
from ardia_cli.browse import tabs
from test_automation import FakeArdia
from test_linux import write_control

with tempfile.TemporaryDirectory(prefix='ac1962-') as temporary:
    root = Path(temporary) / 'Chromium'
    root.mkdir()
    write_control(root)
    server = FakeArdia(root / 'ArdiaControl.sock').start()
    server.replies['windows'] = lambda params: {'result': [{'id': 1, 'tabs': [{'id': 'tab-11', 'targetId': 'PAGE-11', 'pageGeneration': 7}]}]}
    try:
        with mock.patch.dict(os.environ, {'ARDIA_WS': '', 'ARDIA_PORT': '', 'ARDIA_CDP_URL': ''}):
            found = endpoint.resolve(data_dir=str(root))
        state = SimpleNamespace(endpoint=found, config={}, caller=caller.Caller('Terminal'), target_infos={'PAGE-11': {'targetId': 'PAGE-11'}}, app_tabs={}, app_generations={})
        actual_path = tabs.control_socket(state)
        mapping = asyncio.run(tabs.app_tab_map(state))
        print('Platform: Linux')
        print('Control discovery: real mode-0600 JSON with a live PID')
        print('Transport: real Unix socket; existing FakeArdia protocol server')
        print('Expected socket: <scratch>/Chromium/ArdiaControl.sock')
        print('Actual socket:   ' + str(actual_path).replace(temporary, '<scratch>'))
        print('Expected mapping: ' + json.dumps({'PAGE-11': 'tab-11'}, sort_keys=True))
        print('Actual mapping:   ' + json.dumps(mapping, sort_keys=True))
        print('Expected generation: 7')
        print('Actual generation:   ' + str(state.app_generations.get('PAGE-11')))
        print('Socket methods received: ' + json.dumps([method for method, _ in server.requests]))
        assert mapping == {'PAGE-11': 'tab-11'}, 'browse could not map the loaded tab through its discovered socket'
        assert actual_path == root / 'ArdiaControl.sock'
        assert state.app_generations == {'PAGE-11': 7}
        print('PASS: discovery -> socket -> handshake -> windows -> loaded-tab mapping')
    finally:
        server.stop()
