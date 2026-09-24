import {build} from 'esbuild';
import {copyFile} from 'node:fs/promises';

await build({
  stdin: {contents: "export {TrueForge} from '@truefoundry/trueforge-sdk';", resolveDir: process.cwd()},
  outfile: 'extension/vendor/trueforge-sdk.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', minify: true,
  legalComments: 'eof'
});
await copyFile('node_modules/@truefoundry/trueforge-sdk/LICENSE', 'extension/vendor/trueforge-sdk.LICENSE');
