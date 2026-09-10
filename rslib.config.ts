import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginReact } from '@rsbuild/plugin-react';
import { defineConfig, type RsbuildPlugin } from '@rslib/core';

const root = path.dirname(fileURLToPath(import.meta.url));
const generatedRoot = path.join(root, 'src/generated');

const MODULE_LOADER_ID = 'dsh-cursor-agent';

function pluginClientDts(): RsbuildPlugin {
  return {
    name: 'dsh-client-dts',
    setup(api) {
      api.onAfterBuild(async () => {
        const { spawnSync } = await import('node:child_process');
        const fs = await import('node:fs/promises');
        const outDir = path.join(root, 'lib/client');
        await fs.rm(outDir, { recursive: true, force: true });
        const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
        const result = spawnSync(process.execPath, [
          tsc,
          '-p', 'tsconfig.client.json',
          '--declaration',
          '--emitDeclarationOnly',
          '--declarationDir', outDir,
          '--noEmit', 'false',
        ], { cwd: root, stdio: 'inherit' });
        if (result.status !== 0) {
          throw new Error('client declaration emit failed');
        }
        await fs.writeFile(
          path.join(root, 'lib/client.d.ts'),
          'export * from "./client/index.js";\n',
        );
      });
    },
  };
}

function pluginDshClient(): RsbuildPlugin {
  return {
    name: 'dsh-client-module-loader',
    setup(api) {
      api.processAssets(
        { stage: 'optimize-inline', targets: ['web'] },
        ({ assets, compilation, compiler }) => {
          for (const [name, asset] of Object.entries(assets)) {
            if (!name.endsWith('.js')) continue;
            const source = asset.source();
            const code = typeof source === 'string' ? source : source.toString();
            if (code.includes('window.__ModuleLoader__')) continue;
            const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(MODULE_LOADER_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${code}
		return module.exports;
	},
});
`;
            compilation.updateAsset(
              name,
              new compiler.webpack.sources.RawSource(wrapped),
            );
          }
        },
      );
    },
  };
}

export default defineConfig({
  lib: [
    {
      id: 'host',
      format: 'esm',
      syntax: 'es2022',
      bundle: false,
      dts: {
        bundle: false,
        abortOnError: true,
        tsconfigPath: './tsconfig.json',
      },
      source: {
        alias: {
          '#generated': generatedRoot,
        },
        entry: {
          index: [
            './src/**/*.ts',
            '!./src/client/**',
            '!./src/**/*.d.ts',
            '!./src/generated-shims/**',
          ],
        },
      },
      output: {
        target: 'node',
        distPath: {
          root: './lib',
        },
      },
    },
    {
      id: 'client',
      format: 'cjs',
      syntax: 'es2022',
      bundle: true,
      dts: false,
      autoExtension: false,
      source: {
        entry: {
          client: './src/client/index.tsx',
        },
      },
      output: {
        target: 'web',
        distPath: {
          root: './lib',
        },
        filename: {
          js: 'client.js',
        },
        externals: ['react', 'react/jsx-runtime', /^@deepseek-ai\//],
      },
      plugins: [pluginReact(), pluginDshClient(), pluginClientDts()],
    },
  ],
});
