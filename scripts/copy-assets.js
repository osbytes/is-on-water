#!/usr/bin/env node
/**
 * Copy runtime assets next to the compiled output.
 *
 * Everything under data/ prefixed with `_` is build scratch: cached upstream
 * zips (~1.7 GB) and downloaded layer caches. Shipping those would balloon the
 * image, so only the registry, fixtures, and bundled layers are copied.
 */
const { cpSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

cpSync(path.join(ROOT, 'src', 'public'), path.join(ROOT, 'dist', 'public'), {
    recursive: true,
});

cpSync(path.join(ROOT, 'data'), path.join(ROOT, 'dist', 'data'), {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('_'),
});
