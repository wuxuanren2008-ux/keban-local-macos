'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {createHash}=require('node:crypto');
const {spawn}=require('node:child_process');
const extract=require('extract-zip');
const {platformPaths}=require('./platform.cjs');
const version='v0.40.3';
let progress={state:'idle',message:'尚未安装',received:0,total:0};
let installing=null,ownedProcess=null;
async function available(){try{return (await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(1500)})).ok}catch{return false}}
async function startInstalled(dataDir,devRoot){
  if(await available())return true;
  const paths=platformPaths({root:devRoot||'',resourcesPath:'',isPackaged:true,dataDir});
  const candidates=[paths.ollamaExecutable,...paths.ollamaCandidates];
  if(devRoot)candidates.push(path.join(devRoot,'.tools','ollama',process.platform==='darwin'?'ollama':'ollama.exe'));
  const exe=candidates.find(file=>fs.existsSync(file));if(!exe)return false;
  const log=fs.openSync(path.join(dataDir,'ollama.log'),'a');
  ownedProcess=spawn(exe,['serve'],{windowsHide:true,env:{...process.env,OLLAMA_HOST:'127.0.0.1:11434',OLLAMA_NUM_PARALLEL:'1',OLLAMA_NO_CLOUD:'1'},stdio:['ignore',log,log]});
  let failed;ownedProcess.on('error',error=>{failed=error});
  for(let i=0;i<40;i++){if(failed)throw failed;if(await available())return true;await new Promise(resolve=>setTimeout(resolve,500))}
  throw Error('Ollama 下载完成，但本机服务未就绪。请查看 Ollama 日志。');
}
async function install(dataDir){
  if(installing)return installing;
  installing=(async()=>{
    if(await available()){progress={state:'ready',message:'本机 Ollama 已可用'};return progress}
    fs.mkdirSync(dataDir,{recursive:true});
    const paths=platformPaths({root:'',resourcesPath:'',isPackaged:true,dataDir});
    const asset=paths.ollamaAsset;
    const zip=path.join(dataDir,asset);
    const base='https://github.com/ollama/ollama/releases/download/'+version+'/';
    progress={state:'download',message:process.platform==='darwin'?'下载官方 macOS Ollama 运行环境（约 170 MB）':'下载官方 Ollama 运行环境（约 1.5 GB）',received:0,total:0};
    const response=await fetch(base+asset,{signal:AbortSignal.timeout(3600000)});
    if(!response.ok)throw Error('官方 Ollama 下载失败：HTTP '+response.status);
    progress.total=Number(response.headers.get('content-length'))||0;
    const hash=createHash('sha256');const source=Readable.fromWeb(response.body);
    source.on('data',chunk=>{progress.received+=chunk.length;hash.update(chunk)});
    await pipeline(source,fs.createWriteStream(zip));
    const hashes=await fetch(base+'sha256sum.txt',{signal:AbortSignal.timeout(60000)});
    if(!hashes.ok)throw Error('无法获取官方校验值');
    const line=(await hashes.text()).split('\n').find(row=>row.trim().endsWith(asset));
    const expected=line?.trim().split(/\s+/)[0].toLowerCase();
    if(!expected||hash.digest('hex')!==expected)throw Error('Ollama 文件校验失败，未运行下载内容。');
    progress.message='校验通过，正在解压本机运行环境…';
    const destination=path.join(dataDir,'ollama');
    if(process.platform==='darwin'){
      fs.mkdirSync(destination,{recursive:true});
      await new Promise((resolve,reject)=>{const unpack=spawn('/usr/bin/tar',['-xzf',zip,'-C',destination],{stdio:'ignore'});unpack.on('error',reject);unpack.on('exit',code=>code===0?resolve():reject(Error('Ollama 解压失败：'+code)))});
      fs.chmodSync(paths.ollamaExecutable,0o755);
    }else await extract(zip,{dir:destination});
    await startInstalled(dataDir);progress={state:'ready',message:'本机 Ollama 已启动，请下载所选 LLM。'};return progress;
  })().catch(error=>{progress={state:'error',message:error.message};throw error}).finally(()=>installing=null);
  return installing;
}
module.exports={install,startInstalled,progress:()=>progress,stop:()=>{if(ownedProcess&&!ownedProcess.killed)ownedProcess.kill()}};
