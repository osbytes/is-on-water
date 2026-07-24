#!/usr/bin/env node
/**
 * Check npm for a newer @geo-maps/earth-waterbodies-1m.
 * If updated, rebuild the FlatGeobuf dataset and exit 0 with updated=true.
 * If unchanged, exit 0 with updated=false.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
const SOURCE_PACKAGE = '@geo-maps/earth-waterbodies-1m';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

function setOutput(name, value) {
    console.log(`${name}=${value}`);
    if (!GITHUB_OUTPUT) return;
    writeFileSync(GITHUB_OUTPUT, `${name}=${value}\n`, { flag: 'a' });
}

function loadManifest() {
    if (!existsSync(MANIFEST_PATH)) {
        return null;
    }
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function fetchLatestVersion() {
    const result = spawnSync(
        'npm',
        ['view', SOURCE_PACKAGE, 'version', '--json'],
        { encoding: 'utf8', shell: process.platform === 'win32' }
    );
    if (result.status !== 0) {
        throw new Error(
            `npm view failed: ${result.stderr || result.stdout || result.status}`
        );
    }
    return JSON.parse(result.stdout.trim());
}

function installSource(version) {
    const result = spawnSync(
        'pnpm',
        ['add', '-D', `${SOURCE_PACKAGE}@${version}`],
        { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }
    );
    if (result.status !== 0) {
        throw new Error(`Failed to install ${SOURCE_PACKAGE}@${version}`);
    }
}

function rebuild() {
    const result = spawnSync(
        'node',
        [path.join(__dirname, 'build-waterbodies-fgb.js')],
        {
            cwd: ROOT,
            stdio: 'inherit',
            env: {
                ...process.env,
                FGB_BUILDER: process.env.FGB_BUILDER || 'auto',
            },
        }
    );
    if (result.status !== 0) {
        throw new Error('Dataset rebuild failed');
    }
}

function main() {
    mkdirSync(DATA_DIR, { recursive: true });
    const manifest = loadManifest();
    const latestVersion = fetchLatestVersion();
    console.log(`Latest npm version: ${latestVersion}`);
    console.log(
        `Pinned manifest version: ${manifest ? manifest.sourceVersion : '(none)'}`
    );

    if (manifest && manifest.sourceVersion === latestVersion) {
        console.log('Dataset is up to date.');
        setOutput('updated', 'false');
        setOutput('source_version', latestVersion);
        return;
    }

    console.log('Dataset update detected; rebuilding FlatGeobuf…');
    installSource(latestVersion);
    rebuild();

    const next = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    setOutput('updated', 'true');
    setOutput('source_version', next.sourceVersion);
    setOutput('previous_version', manifest ? manifest.sourceVersion : '');
    setOutput(
        'feature_count',
        String(next.polygonPartCount || next.featureCount)
    );
}

main();
