'use strict';
const {sameOrigin}=require('./platform.cjs');
function captureSupport(platform,version=''){
  if(platform==='win32')return {supported:true,nativePicker:false};
  const [major,minor]=version.split('.').map(Number);
  if(platform==='darwin')return {supported:major>14||(major===14&&minor>=2),nativePicker:major>=15};
  return {supported:false,nativePicker:false};
}
function installSystemCapture({session,desktopCapturer,owner,origin,platform,version}){
  const support=captureSupport(platform,version);
  let expires=0;
  function trusted(contents,url){return !!owner()&&contents===owner().webContents&&sameOrigin(url,origin)}
  function arm(event){
    if(!trusted(event.sender,event.senderFrame?.url))throw Error('Only the local classroom may capture system audio');
    if(!support.supported)throw Error('系统声音字幕需要 Windows 或 macOS 14.2 及更新版本。');
    expires=Date.now()+120000;return support;
  }
  function armed(){return Date.now()<expires}
  function clear(){expires=0}
  session.setDisplayMediaRequestHandler(async(request,callback)=>{
    if(!support.supported||!armed()||request.frame!==owner()?.webContents.mainFrame||!sameOrigin(request.frame?.url,origin)||!request.audioRequested){callback(null);return}
    clear();
    try{
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:0,height:0}});
      if(!sources.length||owner()?.isDestroyed())return callback(null);
      callback({video:sources[0],audio:'loopback'});
    }catch{callback(null)}
  },{useSystemPicker:support.nativePicker});
  return {arm,armed,clear,trusted,support};
}
module.exports={captureSupport,installSystemCapture};
