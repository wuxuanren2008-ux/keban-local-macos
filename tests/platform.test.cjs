const {test}=require('node:test');
const assert=require('node:assert/strict');
const {platformPaths,sameOrigin}=require('../desktop/platform.cjs');
test('packaged macOS uses the native runtime and CPU Whisper',()=>{
  const p=platformPaths({platform:'darwin',arch:'arm64',root:'/source',resourcesPath:'/Applications/课伴.app/Contents/Resources',isPackaged:true,dataDir:'/users/test/data'});
  assert.ok(p.executable.endsWith('/runtime/lecture-runtime'));assert.deepEqual(p.supportedAsrDevices,['cpu']);assert.equal(p.ollamaAsset,'ollama-darwin.tgz');assert.ok(p.ollamaExecutable.endsWith('/ollama/ollama'));
});
test('Intel development also uses a Unix Python executable',()=>{
  const p=platformPaths({platform:'darwin',arch:'x64',root:'/source',resourcesPath:'/bundle',isPackaged:false,dataDir:'/data'});
  assert.ok(p.executable.endsWith('/.venv/bin/python'));assert.equal(p.args.length,1);
});
test('media origin comparisons accept normalized URLs and reject foreign origins',()=>{
  assert.equal(sameOrigin('http://127.0.0.1:8766/','http://127.0.0.1:8766'),true);
  assert.equal(sameOrigin('http://127.0.0.1:8767/','http://127.0.0.1:8766'),false);
  assert.equal(sameOrigin('https://evil.example','http://127.0.0.1:8766'),false);
});
