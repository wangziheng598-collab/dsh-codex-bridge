#!/usr/bin/env node
/**
 * Static validation of the marketplace, plugin manifest, MCP registration,
 * skill, and assets. Runs in CI and locally; no dependencies.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.error(`FAIL ${label}: ${error.message}`);
  }
}

function readJson(relative) {
  const file = path.join(root, relative);
  if (!existsSync(file)) throw new Error(`missing ${relative}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON in ${relative}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const marketplacePath = '.agents/plugins/marketplace.json';
const marketplace = readJson(marketplacePath);

check('marketplace declares a name', () => assert(typeof marketplace.name === 'string' && marketplace.name.length > 0, 'name is required'));
check('marketplace has plugins', () => assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'plugins must be non-empty'));

for (const entry of marketplace.plugins) {
  const pluginPath = typeof entry.source === 'string' ? entry.source : entry.source && entry.source.path;
  check(`marketplace entry ${entry.name} points at a directory`, () => {
    assert(typeof pluginPath === 'string', 'source path is required');
    const directory = path.resolve(root, pluginPath);
    assert(existsSync(directory) && statSync(directory).isDirectory(), `${pluginPath} is not a directory`);
  });

  const base = path.resolve(root, pluginPath);
  const manifest = readJson(path.join(path.relative(root, base), '.codex-plugin/plugin.json'));

  check(`${entry.name}: manifest fields`, () => {
    assert(manifest.name === entry.name, `plugin name ${manifest.name} != marketplace name ${entry.name}`);
    assert(/^\d+\.\d+\.\d+/.test(manifest.version), 'version must be semver-like');
    assert(typeof manifest.description === 'string' && manifest.description.length > 10, 'description is required');
    assert(manifest.license === 'MIT', 'license must be MIT');
  });

  check(`${entry.name}: MCP registration`, () => {
    const mcpFile = path.resolve(base, manifest.mcpServers);
    assert(existsSync(mcpFile), `${manifest.mcpServers} does not exist`);
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
    assert(mcp.mcpServers && typeof mcp.mcpServers === 'object', 'mcpServers object is required');
    for (const [name, server] of Object.entries(mcp.mcpServers)) {
      assert(typeof server.command === 'string', `${name}: command is required`);
      assert(Array.isArray(server.args) && server.args.length > 0, `${name}: args are required`);
      for (const arg of server.args) {
        if (!arg.startsWith('./') && !arg.startsWith('../')) continue;
        assert(existsSync(path.resolve(base, arg)), `${name}: ${arg} does not exist`);
      }
    }
  });

  check(`${entry.name}: skills and interface assets`, () => {
    if (manifest.skills) {
      const skillsDir = path.resolve(base, manifest.skills);
      assert(existsSync(skillsDir), `${manifest.skills} does not exist`);
      const index = path.join(skillsDir, 'dsh', 'SKILL.md');
      assert(existsSync(index), 'skills/dsh/SKILL.md is missing');
    }
    for (const key of ['composerIcon', 'logo']) {
      const value = manifest.interface && manifest.interface[key];
      if (!value) continue;
      const asset = path.resolve(base, value);
      assert(existsSync(asset), `${value} does not exist`);
      assert(statSync(asset).size > 0, `${value} is empty`);
    }
  });
}

check('Claude Code marketplace mirror', () => {
  const mirror = readJson('.claude-plugin/marketplace.json');
  assert(mirror.name === marketplace.name, 'mirror name should match the Codex marketplace');
  assert(Array.isArray(mirror.plugins) && mirror.plugins.length > 0, 'mirror needs plugins');
});

check('documentation and license', () => {
  for (const file of ['README.md', 'README.zh-CN.md', 'LICENSE', '.gitignore']) {
    assert(existsSync(path.join(root, file)), `${file} is missing`);
  }
});

if (failures.length > 0) {
  console.error(`\n${failures.length} validation failure(s).`);
  process.exit(1);
}
console.log('\nAll manifests and assets are valid.');
