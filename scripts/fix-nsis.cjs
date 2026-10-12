/* Windows 10/11 do not need the legacy Win7 known-folder probe.
   Its System plugin copies NSIS_MAX_STRLEN past a short shell buffer and can
   crash first-time per-user installs: electron-builder issue #7921.
   Patch only this pinned template, retaining the normal per-user install path. */
const fs=require('node:fs');
const path=require('node:path');
const file=path.join(__dirname,'..','node_modules','app-builder-lib','templates','nsis','multiUser.nsh');
const source=fs.readFileSync(file,'utf8');
const start=source.indexOf('      System::Store S');
const end=source.indexOf('      System::Store L',start);
if(start>=0&&end>start){
  const block=source.slice(start,end+'      System::Store L'.length);
  if(!block.includes('SHGetKnownFolderPath'))throw Error('Unexpected NSIS template: refusing to patch');
  fs.writeFileSync(file,source.replace(block,'      # Use LocalAppData on supported Windows versions; avoid the unsafe Win7 shell buffer probe.'));
  console.log('Fixed legacy NSIS per-user known-folder crash');
}else if(!source.includes('avoid the unsafe Win7 shell buffer probe')){
  throw Error('NSIS template changed; review the installer compatibility fix');
}
