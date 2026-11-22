// version.js — the ONE version string, read from package.json, so the CLI
// tools' --version can never drift apart from each other or the package.
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
