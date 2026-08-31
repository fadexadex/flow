#!/usr/bin/env python3
"""Re-embed public/addons/webmcp/plugin.{gd,cfg} into public/mcp_bridge.js verbatim."""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
gd = (root / 'public/addons/webmcp/plugin.gd').read_text()
cfg = (root / 'public/addons/webmcp/plugin.cfg').read_text()
for name, text in (('plugin.gd', gd), ('plugin.cfg', cfg)):
    for bad in ('`', '${', '\\'):
        if bad in text:
            sys.exit(f'{name} contains {bad!r}, which cannot be embedded verbatim in a template literal.')
bridge_path = root / 'public/mcp_bridge.js'
bridge = bridge_path.read_text()
for const, text in (('WEBMCP_PLUGIN_CFG', cfg), ('WEBMCP_PLUGIN_GD', gd)):
    pattern = re.compile(r'(const %s = `)(.*?)(`;)' % const, re.S)
    if not pattern.search(bridge):
        sys.exit(f'Could not locate {const} in mcp_bridge.js')
    bridge = pattern.sub(lambda m: m.group(1) + text + m.group(3), bridge, count=1)
bridge_path.write_text(bridge)
print('Embedded plugin.gd (%d bytes) and plugin.cfg (%d bytes).' % (len(gd), len(cfg)))
