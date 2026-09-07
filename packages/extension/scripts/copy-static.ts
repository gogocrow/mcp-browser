import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// manifest.json / popup.html 不经过打包，直接原样进 dist
cpSync(join(root, 'public'), join(root, 'dist'), { recursive: true });
process.stdout.write('static assets -> dist\n');
