#!/usr/bin/env python3
"""Generate public/webmcp_plugin_source.js from public/addons/webmcp/plugin.{gd,cfg}.

The plugin exists twice on purpose: once as real, readable GDScript that Godot can load from
disk, and once as a JavaScript string the bridge injects into every authored project at boot.
This keeps the second copy generated and out of mcp_bridge.js, where it was ~1500 lines of
GDScript embedded in two template literals.
"""
import sys, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
gd = (root / 'public/addons/webmcp/plugin.gd').read_text()
cfg = (root / 'public/addons/webmcp/plugin.cfg').read_text()

for name, text in (('plugin.gd', gd), ('plugin.cfg', cfg)):
    for bad in ('`', '${', '\\'):
        if bad in text:
            sys.exit(f'{name} contains {bad!r}, which cannot be embedded verbatim in a template literal.')

target = root / 'public/webmcp_plugin_source.js'
target.write_text(
    '// GENERATED FILE - do not edit.\n'
    '// Regenerate with: python3 scripts/embed_plugin.py\n'
    '// Source of truth: public/addons/webmcp/plugin.gd and plugin.cfg\n'
    '//\n'
    '// Loaded before mcp_bridge.js, which injects this source into every authored project so\n'
    '// the editor command channel exists inside Godot itself.\n'
    'window.__WEBMCP_PLUGIN_SOURCE = {\n'
    '  cfg: `' + cfg + '`,\n'
    '  gd: `' + gd + '`\n'
    '};\n'
)
print('Generated %s (plugin.gd %d bytes, plugin.cfg %d bytes).' % (target.name, len(gd), len(cfg)))
