const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function loadInventoryModule(name) {
  const file = path.resolve(__dirname, '../src/features/inventarios', `${name}.ts`);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(id => {
    if (id === './utils') return loadInventoryModule('utils');
    if (id === '@/lib/safeExcel') return {}; // Not used by rotation reads.
    throw new Error(`Unexpected dependency: ${id}`);
  }, module, module.exports);
  return module.exports;
}
module.exports = { loadInventoryModule };
