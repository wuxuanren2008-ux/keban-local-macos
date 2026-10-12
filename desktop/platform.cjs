'use strict';
const path=require('node:path');
function platformPaths({platform=process.platform,arch=process.arch,root,resourcesPath,isPackaged,dataDir}){
  if(!['win32','darwin'].includes(platform))throw Error('目前提供 Windows 与 macOS 原生版本。');
  if(!['arm64','x64'].includes(arch))throw Error('此 CPU 架构不受支持：'+arch);
  const windows=platform==='win32';
  const join=windows?path.win32.join:path.posix.join;
  return {
    platform,arch,
    executable:isPackaged?join(resourcesPath,'runtime',windows?'lecture-runtime.exe':'lecture-runtime'):join(root,'.venv',windows?'Scripts':'bin',windows?'python.exe':'python'),
    args:isPackaged?[]:[join(root,'desktop','launcher.py')],
    web:isPackaged?join(resourcesPath,'web'):join(root,'desktop','web'),
    ollamaAsset:windows?'ollama-windows-amd64.zip':'ollama-darwin.tgz',
    ollamaExecutable:join(dataDir,'ollama',windows?'ollama.exe':'ollama'),
    ollamaCandidates:windows?[]:['/Applications/Ollama.app/Contents/Resources/ollama','/opt/homebrew/bin/ollama','/usr/local/bin/ollama'],
    supportedAsrDevices:windows?['cpu','cuda']:['cpu']
  };
}
function sameOrigin(url,expected){try{return new URL(url).origin===expected}catch{return false}}
module.exports={platformPaths,sameOrigin};
