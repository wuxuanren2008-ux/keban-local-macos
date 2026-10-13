/* Desktop integration. The existing website remains the source of the UI. */
(() => {
  'use strict';
  const fragment=new URLSearchParams(location.hash.slice(1));
  window.localToken=fragment.get('token')||sessionStorage.getItem('lecture-token')||'';
  sessionStorage.setItem('lecture-token',window.localToken);
  if(fragment.has('token'))history.replaceState(null,'',location.pathname);
  let records=[],courses=[],settings={},saveQueue=Promise.resolve(),map=null,booted=false;
  let translationBusyLocal=0,waiters=[];
  const pendingAudioWrites=new Set(),pendingTranslations=new Set();
  window.localCourseId=localStorage.getItem('lc_desktop_course')||'';

  async function api(path,options={}){
    const response=await fetch('/api/'+path,{...options,headers:{'X-Lecture-Token':window.localToken,...(typeof options.body==='string'?{'Content-Type':'application/json'}:{}),...options.headers}});
    if(!response.ok){let error;try{error=await response.json()}catch{}throw Error(error?.detail||error?.error||'本机服务请求失败 ('+response.status+')')}
    return options.blob?response.blob():response.status===204?null:response.json();
  }
  const post=(path,body,signal)=>api(path,{method:'POST',body:JSON.stringify(body),signal});
  window.localAI=(body,signal)=>post('ai',{...body,course_id:window.localCourseId},signal||AbortSignal.timeout(900000));
  // Used by the Electron close handler and automated checks; it never exports text.
  window.localFlush=async()=>{archiveCurrent();await saveQueue};
  window.localBeforeClose=async()=>{
    if(studioStarting||window.localCaptureBusy)throw Error('声音采集仍在启动，请稍候再关闭。');
    const audio=recorder&&['recording','paused'].includes(recorder.state)?new Promise(resolve=>recorder.addEventListener('stop',resolve,{once:true})):Promise.resolve();
    if(active)stop();
    const drain=recognition?.drained||Promise.resolve();
    const finish=(async()=>{await Promise.all([audio,drain]);await Promise.all([...pendingAudioWrites]);await Promise.all([...pendingTranslations]);await window.localFlush()})();
    await Promise.race([finish,new Promise((_,reject)=>setTimeout(()=>reject(Error('字幕翻译或录音保存尚未完成')),60000))]);
  };

  localRecords=()=>records;
  const originalSnapshot=snapshotClass;
  snapshotClass=function(){const snapshot=originalSnapshot();snapshot.transcript=snapshot.transcript.map((row,index)=>({...row,recognized_text:items[index]?.recognized_text,original_corrected:!!items[index]?.original_corrected}));return {...snapshot,course_id:window.localCourseId,mindmap:map}};
  archiveCurrent=function(){
    if(!booted||(!items.length&&!$('personalNotes').value.trim()&&!studioAudio))return;
    const row=snapshotClass();const index=records.findIndex(x=>x.id===row.id);
    if(index<0)records.unshift(row);else records[index]=row;
    $('draftStatus').textContent='正在保存到本机课程资料库…';
    saveQueue=saveQueue.catch(()=>{}).then(()=>post('lectures',row)).then(()=>{$('draftStatus').textContent='已保存到本机 · '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}).catch(error=>{$('draftStatus').textContent='保存失败：'+error.message;toast('保存失败，请导出课堂备份。');throw error});
    // Mark the promise handled without making the error invisible to explicit flush.
    saveQueue.catch(()=>{});
  };
  storeAudio=function(owner,id,blob){
    const write=(async()=>{await saveQueue;await api('lectures/'+encodeURIComponent(id)+'/audio',{method:'PUT',body:blob,headers:{'Content-Type':blob.type||'audio/webm'}});const row=records.find(x=>x.id===id);if(row)row.hasAudio=true})();
    pendingAudioWrites.add(write);write.finally(()=>pendingAudioWrites.delete(write)).catch(()=>{});return write;
  };
  readAudio=async function(owner,id){const row=records.find(x=>x.id===id);if(!row?.hasAudio)return null;return api('lectures/'+encodeURIComponent(id)+'/audio',{blob:true})};
  removeAudio=async()=>{}; // Deletion is one atomic API operation below.

  refreshGlossary=async function(){const data=await api('glossary?course_id='+encodeURIComponent(window.localCourseId));personalGlossary=data.terms||[];renderGlossary()};
  saveGlossary=async function(item,value){
    if(!value?.trim())return toast('请输入确认的译文。');
    const course=window.localCourseId,id=studioId;
    try{await post('corrections',{course_id:course,source_term:item.text.trim(),preferred_translation:value.trim(),source_language:item.code?.startsWith('ms')?'ms':item.code?.startsWith('zh')?'zh':'en',target_language:$('target').value});if(course!==window.localCourseId||id!==studioId)return;item.translation=value.trim();item.user_corrected=true;await refreshGlossary();render();await learningStatus();toast('已确认修正；该课程今后的翻译会参考它。')}catch(e){toast(e.message)}
  };
  const localRender=render;
  render=function(){
    localRender();
    $('stream').querySelectorAll('.entry:not(.interim-entry)').forEach(article=>{
      const index=Number(article.querySelector('[data-star]')?.dataset.star),item=items[index];if(!item)return;
      const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='修正原文与识别术语';details.append(summary);
      const row=document.createElement('div');row.className='correction-row';const input=document.createElement('input');input.className='fix-input';input.value=item.text;input.setAttribute('aria-label','修正第 '+(index+1)+' 条原文');
      const button=document.createElement('button');button.className='btn';button.textContent='确认原文';
      button.onclick=async()=>{const value=input.value.trim();if(!value)return;item.recognized_text||=item.text;item.text=value;item.original_corrected=true;
        if(item.user_corrected&&item.translation){await saveGlossary(item,item.translation)}else{item.translation='';item.user_corrected=false;translate(item)}render();archiveCurrent();toast('原文已确认。保存术语或修正译文后，Whisper 会参考正确的专业词。')};row.append(input,button);details.append(row);article.append(details);
    });
  };
  renderGlossary=function(){
    $('addTerm').disabled=!booted;
    $('glossaryList').innerHTML=personalGlossary.length?personalGlossary.map((g,i)=>'<div class="glossary-row"><strong>'+escapeHtml(g.source_term)+'</strong><span>'+escapeHtml(g.preferred_translation)+'</span><button data-remove-term="'+i+'" aria-label="删除术语 '+escapeHtml(g.source_term)+'">删除</button></div>').join(''):'<p class="sub">本课程尚无确认的术语。可以手动添加，或在字幕中保存修正。</p>';
    $('glossaryList').querySelectorAll('[data-remove-term]').forEach(button=>button.onclick=async()=>{if(!confirm('删除这条确认术语？'))return;try{await api('corrections',{method:'DELETE',body:JSON.stringify({...personalGlossary[Number(button.dataset.removeTerm)],course_id:window.localCourseId})});await refreshGlossary();await learningStatus()}catch(error){toast(error.message)}});
  };
  $('glossaryForm').onsubmit=async event=>{event.preventDefault();const term=$('termSource').value.trim(),value=$('termTranslation').value.trim();if(term&&value){await saveGlossary({text:term,code:$('source').value},value);$('glossaryForm').reset()}};

  translate=async function(item){
    if(!item||item._translating)return;const id=studioId,course=window.localCourseId,target=$('target').value,text=item.text;
    const valid=()=>studioId===id&&window.localCourseId===course&&items.includes(item)&&$('target').value===target&&item.text===text&&!item.user_corrected;
    item._translating=true;
    try{
      if(translationBusyLocal>=1)await new Promise(resolve=>waiters.push(resolve));else translationBusyLocal++;
      try{if(!valid())return;const data=await post('ai',{operation:'translate_lecture',course_id:course,text,source:item.code?.startsWith('ms')?'ms':item.code?.startsWith('zh')?'zh':'en',target},AbortSignal.timeout(300000));if(valid())item.translation=data.translation}
      finally{const next=waiters.shift();if(next)next();else translationBusyLocal--}
    }catch(error){if(valid())item.translation='（翻译暂不可用：'+error.message+'）'}
    finally{item._translating=false;if(studioId===id&&items.includes(item)){if((target!==$('target').value||text!==item.text)&&!item.user_corrected)translate(item);render()}}
  };
  const localTranslate=translate;
  translate=function(item){const task=localTranslate(item);pendingTranslations.add(task);task.finally(()=>pendingTranslations.delete(task)).catch(()=>{});return task};
  makeSummary=async function(){
    if(!items.length||$('summarize').dataset.busy)return;
    if(active||recognition?.closing)return toast('请先结束课堂并等待尾句确认，再生成完整总结。');
    const id=studioId,course=window.localCourseId,transcript=serializedItems();
    $('summarize').dataset.busy='true';$('summarize').disabled=true;$('summarize').textContent='正在整理整堂课堂…';
    try{const data=await post('ai',{operation:'summarize',title:$('title').value||'课堂记录',course_id:course,transcript,targetLanguage:$('target').value},AbortSignal.timeout(1200000));if(id!==studioId||course!==window.localCourseId)return;map=data.mindmap||null;showSummary(safeSummary(data.summary));renderMap();archiveCurrent();await saveQueue;toast('课堂总结与知识结构已保存。')}
    catch(error){toast('总结未完成：'+error.message)}
    finally{delete $('summarize').dataset.busy;$('summarize').textContent='✦ 生成课堂总结';updateCount()}
  };
  const originalCount=updateCount;
  updateCount=function(){originalCount();$('summarize').disabled=!booted||!items.length||!!$('summarize').dataset.busy;$('cloudSave').disabled=!items.length};
  $('summarize').onclick=makeSummary;
  const feedback=document.createElement('details');feedback.innerHTML='<summary>改进本课程的总结重点</summary><label class="notes-label" for="summaryFeedback">指出遗漏重点、错误概念或希望采用的整理方式</label><textarea id="summaryFeedback" maxlength="2000" placeholder="例如：区分沉没成本与机会成本，先写定义，再比较决策中的作用。"></textarea><button class="btn" id="saveSummaryFeedback">确认并记住改进建议</button><p class="sub">只参考你确认的建议；新总结仍以当堂原文为证据。保存后可重新生成。</p>';$('summaryPane').append(feedback);
  $('saveSummaryFeedback').onclick=async()=>{const value=$('summaryFeedback').value.trim();if(!value)return toast('请填写具体改进建议。');try{await window.localFlush();await post('feedback',{course_id:window.localCourseId,lecture_id:studioId,feedback:value});$('summaryFeedback').value='';await learningStatus();toast('已保存本课程的总结改进建议。')}catch(error){toast(error.message)}};
  const originalStudy=showStudy;
  showStudy=function(name){originalStudy(name);$('mindmapPane').classList.toggle('hidden',name!=='mindmap');if(name==='mindmap')renderMap()};
  document.querySelectorAll('[data-study]').forEach(button=>button.onclick=()=>showStudy(button.dataset.study));
  function renderMap(){
    const container=$('mindmapContent');container.replaceChildren();
    if(!map?.nodes?.length){const p=document.createElement('p');p.className='sub';p.textContent='生成课堂总结后，在这里查看知识结构与对应字幕。';container.append(p);return}
    const heading=document.createElement('h3');heading.textContent=map.title||$('title').value;container.append(heading);
    const nodes=map.nodes.slice(0,200),byId=new Map(nodes.map(n=>[String(n.id),n])),seen=new Set();
    function tree(parent,depth){const list=document.createElement('ul');list.className='map-tree';if(depth>8)return list;for(const node of nodes.filter(n=>(n.parent==null||n.parent==='')?parent===null:String(n.parent)===parent)){
      const id=String(node.id);if(seen.has(id))continue;seen.add(id);const li=document.createElement('li'),button=document.createElement('button');button.className='map-node';button.textContent=node.label||'';
      const sources=(node.source_ids||[]).map(source=>{const match=String(source).match(/\d+/);const number=match?Number(match[0]):NaN;return {id:source,item:transcriptForSource(number)}}).filter(x=>x.item);
      const small=document.createElement('small');small.textContent=sources.length?'来源：'+sources.map(s=>s.item.time).join(' · '):'知识结构';button.append(small);button.onclick=()=>{if(!sources.length)return;const item=sources[0].item;$('transcriptSearch').value=item.text.slice(0,45);render();if(studioAudio&&!active)seekAudio(item.time)};li.append(button,tree(id,depth+1));list.append(li)
    }return list}
    function transcriptForSource(index){return items[index]||null}
    // Only validated nodes with a reachable parent are drawn; never execute labels as HTML.
    if(map.derived_outline){const note=document.createElement('p');note.className='sub';note.textContent='根据课堂重点整理的大纲；无对应引用的节点不显示来源。';container.append(note)}
    container.append(tree(null,0));
    if(!seen.size){const p=document.createElement('p');p.textContent='导图没有可显示的根节点，请重新生成。';container.append(p)}
  }
  $('exportMindmap').onclick=()=>{if(!map?.nodes?.length)return toast('请先生成总结。');const format=confirm('导出可迁移的 JSON 导图？点击取消导出 Markdown 大纲。')?'json':'md';const content=format==='json'?JSON.stringify(map,null,2):['# '+map.title,...map.nodes.map(n=>{let depth=0,parent=n.parent,visited=new Set();while(parent&&depth<8&&!visited.has(parent)){visited.add(parent);depth++;parent=map.nodes.find(x=>String(x.id)===String(parent))?.parent}return '  '.repeat(depth)+'- '+n.label+((n.source_ids||[]).length?' （来源 '+n.source_ids.join(', ')+')':'')})].join('\n');downloadFile(content,'text/plain;charset=utf-8','-思维导图.'+format)};

  renderLibrary=function(){
    const search=$('librarySearch').value.trim().toLowerCase();const rows=records.filter(row=>row.course_id===window.localCourseId&&String(row.title||'').toLowerCase().includes(search));
    $('lectureList').innerHTML=rows.length?rows.map(row=>'<article class="lecture-card"><div class="row"><span class="source-tag">'+escapeHtml(courses.find(c=>c.id===row.course_id)?.name||'课程')+'</span><button class="text-btn" data-delete="'+escapeHtml(row.id)+'">删除课堂</button></div><h3>'+escapeHtml(row.title||'未命名课堂')+'</h3><p class="sub">'+escapeHtml(new Date(row.created_at).toLocaleString())+'</p><p class="sub">'+(row.transcript?.length||0)+' 句 · '+(row.hasAudio?'录音可回听':'文字记录')+(row.summary?' · 已整理总结':'')+'</p><button class="btn" data-open-local="'+escapeHtml(row.id)+'">打开课堂 →</button></article>').join(''):'<div class="no-results">'+(search?'没有找到匹配的课堂。':'这门课程还没有课堂记录。')+'</div>';
    $('lectureList').querySelectorAll('[data-open-local]').forEach(button=>button.onclick=()=>openLecture(button.dataset.openLocal));
    $('lectureList').querySelectorAll('[data-delete]').forEach(button=>button.onclick=async()=>{if(active||recognition?.closing)return toast('请先结束课堂并等待尾句。');if(!confirm('删除这节课堂的录音、译文、总结与导图？'))return;try{await saveQueue;await api('lectures/'+encodeURIComponent(button.dataset.delete),{method:'DELETE'});records=records.filter(row=>row.id!==button.dataset.delete);if(studioId===button.dataset.delete)clearClass();renderLibrary()}catch(error){toast(error.message)}});
  };
  refreshCloudLibrary=async function(){if(!booted)return;try{await saveQueue;records=(await api('lectures')).lectures||[];renderLibrary();$('libraryStatus').textContent='本机课程资料库 · '+records.filter(x=>x.course_id===window.localCourseId).length+' 节课堂'}catch(error){$('libraryStatus').textContent=error.message}};
  openLecture=async function(id){
    if(active||studioStarting||window.localCaptureBusy||recognition?.closing)return toast('请先结束课堂并等待尾句确认。');
    try{archiveCurrent();await saveQueue;const row=await api('lectures/'+encodeURIComponent(id));clearTimeout(studioCheckpointTimer);studioId=row.id;studioCreated=row.created_at;window.localCourseId=row.course_id;localStorage.setItem('lc_desktop_course',row.course_id);$('courseSelect').value=row.course_id;items=row.transcript||[];summaryData=row.summary||null;map=row.mindmap||null;qualityRun=null;currentCloudId=null;$('title').value=row.title||'';$('personalNotes').value=row.notes||'';$('source').value=row.language||'en-US';$('target').value=row.target||'zh-CN';$('duration').textContent=row.duration||'00:00';applyPreferences();$('summaryBox').classList.toggle('hidden',!summaryData);document.querySelector('.assistant-intro').classList.toggle('hidden',!!summaryData);if(summaryData)showSummary(summaryData);else renderReview();attachAudio(null);const current=id;const blob=await readAudio('desktop',id);if(studioId!==current)return;attachAudio(blob);showView('classroom');$('sessionLabel').textContent='课堂回顾 · '+new Date(row.created_at).toLocaleString();render();renderMap();await refreshGlossary()}catch(error){toast('打开失败：'+error.message)}
  };
  function clearClass(){clearTimeout(studioCheckpointTimer);studioId=crypto.randomUUID();studioCreated=new Date().toISOString();items=[];map=null;summaryData=null;qualityRun=null;currentCloudId=null;$('title').value='';$('personalNotes').value='';$('duration').textContent='00:00';$('summaryBox').classList.add('hidden');document.querySelector('.assistant-intro').classList.remove('hidden');attachAudio(null);render();renderReview();renderMap()}
  $('newClass').onclick=async()=>{if(active||studioStarting||window.localCaptureBusy||recognition?.closing)return toast('请先结束课堂并等待尾句。');try{await window.localFlush();clearClass();showView('classroom')}catch(e){toast(e.message)}};
  $('cloudSave').onclick=async()=>{try{await window.localFlush();toast('已保存到本机课程资料库。')}catch(e){toast(e.message)}};
  $('cloudLoad').onclick=()=>showView('library');$('refreshLibrary').onclick=refreshCloudLibrary;
  $('cloudDelete').classList.add('hidden');$('libraryScope').classList.add('hidden');$('openAccount').classList.add('hidden');$('assistantLogin').classList.add('hidden');
  $('cloudSave').textContent='保存到本机课程资料库';$('cloudLoad').textContent='查看课程课堂';$('refreshLibrary').textContent='刷新本机资料库';$('cloudHint').textContent='本机保存 · 按课程整理';$('connectionLabel').textContent='本机模式 · Whisper + Qwen';
  $('qualityBanner').classList.add('hidden');$('qualityDialog').close();$('lectureAiConsent').checked=true;$('aiConsent').checked=true;
  // Keep website language and reading settings, replacing cloud data controls.
  $('qualityConsent').closest('.setting-check').classList.add('hidden');$('deleteQuality').classList.add('hidden');
  const settingsBody=$('settingsDialog').querySelector('.modal-body');
  [...settingsBody.children].forEach(node=>{if(node.textContent.includes('供课伴维护团队')||node.textContent.includes('50 MB')||node.textContent==='数据与改进计划')node.classList.add('hidden')});
  settingsBody.querySelector('.modal-footer').textContent='课堂资料保存在本机；模型准备完成后可离线使用。';
  $('qualityConsent').checked=false;qualityEnabled=()=>false;submitQuality=()=>{};syncQualityCorrections=async()=>{};
  const vocabularyHint=$('glossaryView').querySelector('.glossary-card > .sub');if(vocabularyHint)vocabularyHint.textContent='仅参考当前课程中你确认的术语与纠错；也作为 Whisper 的专业词提示。';
  $('documentAuthHint').textContent='本机模型 · 原文在本机处理。';
  const consent=$('documentConsent').closest('label');if(consent)consent.lastChild.textContent='使用本机模型翻译与整理这份资料。';
  document.querySelectorAll('.document-controls p').forEach(p=>{if(/发送|免费|Google/.test(p.textContent))p.textContent='原文件在本机准备，文字通过本机模型分析。扫描 PDF 无可提取文字时会提示；图片与复杂公式需对照原文。'});
  // Route imported backups into the same durable store rather than localStorage.
  $('backupFile').onchange=async()=>{const file=$('backupFile').files[0];$('backupFile').value='';if(!file)return;if(active)return toast('请先结束课堂。');try{if(file.size>10*1024*1024)throw Error('备份超过 10 MB');const value=JSON.parse(await file.text());if(value.format!=='lecture-companion-v1'||!Array.isArray(value.transcript))throw Error('无效课堂备份');await window.localFlush();const row={...value,id:crypto.randomUUID(),course_id:window.localCourseId,hasAudio:false,created_at:new Date().toISOString()};await post('lectures',row);await refreshCloudLibrary();toast('已导入当前课程。')}catch(e){toast('导入失败：'+e.message)}};
  recordingCheck=function(){if(!booted)return '本机资料库正在连接，请稍候。';if(!navigator.mediaDevices?.getUserMedia||!window.AudioWorkletNode||!window.MediaRecorder)return '当前环境无法访问麦克风，请通过桌面软件打开课伴。';return ''};
  // Prevent an old classroom's map from carrying into the new recording.
  const originalStartLocal=start;
  start=async function(preparedStream){if(!booted||recognition?.closing)return toast('正在准备本机服务或确认尾句，请稍候。');if(!preparedStream&&window.localPlatform?.platform==='darwin'&&window.desktopSetup&&!await window.desktopSetup.requestMicrophone())return toast('麦克风权限未开启，请在 macOS 系统设置的隐私与安全性 → 麦克风中允许课伴。');const previousId=studioId;await originalStartLocal(preparedStream);if(studioId!==previousId){map=null;renderMap();archiveCurrent()}$('courseSelect').disabled=active;$('addCourse').disabled=active};$('start').onclick=()=>start();
  const originalStopLocal=stop;
  stop=function(){originalStopLocal();$('courseSelect').disabled=false;$('addCourse').disabled=false;reliabilityNotice('录音已保留，正在确认尾句；字幕确认后自动保存。')};$('stop').onclick=stop;
  const originalOpenSettings=$('openSettings').onclick;
  const modelsButton=document.createElement('button');modelsButton.className='btn';modelsButton.textContent='本机模型与学习设置';modelsButton.type='button';modelsButton.onclick=()=>{openModal('localSettings',modelsButton);refreshHealth().catch(e=>$('modelStatus').textContent=e.message)};settingsBody.insertBefore(modelsButton,$('settingsDone'));
  const dialog=document.createElement('dialog');dialog.id='localSettings';dialog.className='modal';dialog.innerHTML='<div class="modal-head"><h2>本机模型与课程学习</h2><button class="close-btn" id="closeLocalSettings" aria-label="关闭">×</button></div><div class="modal-body"><p class="modal-intro">首次下载后在本机运行。模型占用磁盘与内存；按设备能力选择。</p><div class="field"><label for="llmModel">翻译与学术总结</label><select id="llmModel"><option value="qwen3.5:4b">Qwen3.5 4B · 默认</option><option value="qwen3.5:9b">Qwen3.5 9B · 高配</option><option value="qwen3:8b">Qwen3 8B · 兼容选项</option><option value="gemma3:4b">Gemma3 4B · 对比选项</option></select></div><p class="model-hint">4B 建议 16 GB 内存。9B 与 Whisper 同时使用时，需要更多内存或合理分配显存。</p><div class="field"><label for="asrModel">Whisper 识别模型</label><select id="asrModel"><option value="small">small · 普通笔记本</option><option value="base">base · 更轻</option><option value="large-v3-turbo">large-v3-turbo · 更高质量</option><option value="large-v3">large-v3 · 完整模型</option></select></div><div class="field"><label for="asrDevice">识别设备</label><select id="asrDevice"><option value="cpu">CPU · 无需独立显卡</option><option value="cuda">NVIDIA GPU · 需 CUDA/cuDNN</option></select></div><label class="setting-check"><input type="checkbox" id="localLearning" checked>参考本课程中我确认的术语与纠错</label><p class="sub">学习通过术语提示与纠错例改善模型输出。只积累已确认的修正，不自动修改模型权重。</p><div class="local-status" id="modelStatus" role="status" aria-live="polite"></div><div class="local-settings-actions"><button class="btn" id="saveModels">保存设置</button><button class="btn" id="pullModel">下载 LLM</button><button class="btn" id="prepareWhisper">下载 / 准备 Whisper</button></div><div class="local-settings-actions"><button class="btn" id="refreshModels">检查模型</button><button class="btn" id="exportCorrections">导出纠错</button><button class="btn" id="resetLearning">重置本课程学习</button></div><p class="sub">请先安装并启动 <a href="https://ollama.com/download/windows" target="_blank" rel="noopener">Ollama</a>。模型下载需要网络；课文只发送到本机 Ollama。</p></div>';document.body.append(dialog);
  $('closeLocalSettings').onclick=()=>dialog.close();
  for(const [value,label] of [['qwen3.5:2b','Qwen3.5 2B · 低内存选项'],['qwen3.5:0.8b','Qwen3.5 0.8B · 最轻量']]){const option=document.createElement('option');option.value=value;option.textContent=label;$('llmModel').append(option)}
  $('localLearning').parentElement.lastChild.textContent='启用课程纠错学习（全局开关，资料按课程隔离）';
  const runnerButton=document.createElement('button');runnerButton.id='installRunner';runnerButton.className='btn';runnerButton.textContent='一键准备 Ollama';$('pullModel').parentElement.prepend(runnerButton);
  runnerButton.onclick=async()=>{
    if(!window.desktopSetup)return toast('请通过课伴桌面软件准备运行环境。');runnerButton.disabled=true;
    const timer=setInterval(async()=>{try{const progress=await window.desktopSetup.progress();$('modelStatus').textContent=progress.message+(progress.total?' · '+Math.round(progress.received/progress.total*100)+'%':'')}catch{}},1000);
    try{await window.desktopSetup.installOllama();await refreshHealth();toast('本机运行环境已准备。接下来下载 LLM。')}catch(error){$('modelStatus').textContent='运行环境准备失败：'+error.message}finally{clearInterval(timer);runnerButton.disabled=false}
  };
  async function learningStatus(){const data=await api('learning?course_id='+encodeURIComponent(window.localCourseId));const count=Array.isArray(data.corrections)?data.corrections.length:Number(data.corrections)||0;$('learningStatus').textContent='课程学习：'+(data.enabled===false?'已关闭':count+' 条译文修正 · '+(data.feedback_count||0)+' 条总结建议');return data}
  async function refreshHealth(){const health=await api('health');settings=await api('settings');$('llmModel').value=settings.llm_model||'qwen3.5:4b';$('asrModel').value=settings.asr_model||'small';$('asrDevice').value=settings.asr_device||'cpu';$('localLearning').checked=settings.learning_enabled!==false;$('modelStatus').textContent='本机 LLM：'+(health.llm?.ready?'可用':'尚未就绪，请启动 Ollama 并下载所选模型')+'\nWhisper：'+(health.asr?.ready?'可用':'尚未加载，点击准备模型')+'\n资料位置：'+(health.data_dir||'本机应用资料目录');await learningStatus();return health}
  $('saveModels').onclick=async()=>{if(active)return toast('请先结束课堂再切换模型。');try{settings=await post('settings',{llm_model:$('llmModel').value,asr_model:$('asrModel').value,asr_device:$('asrDevice').value,learning_enabled:$('localLearning').checked});await refreshHealth();toast('本机设置已保存。')}catch(e){toast(e.message)}};
  $('pullModel').onclick=async()=>{const button=$('pullModel');button.disabled=true;$('modelStatus').textContent='正在下载所选 LLM，可能需要数分钟。请保持软件打开。';try{await post('models/pull',{model:$('llmModel').value},AbortSignal.timeout(3600000));await refreshHealth();toast('模型下载完成。')}catch(e){$('modelStatus').textContent=e.message}finally{button.disabled=false}};
  $('prepareWhisper').onclick=async()=>{
    if(active)return toast('请先结束课堂。');$('prepareWhisper').disabled=true;$('modelStatus').textContent='正在准备 Whisper；首次会下载模型，请保持软件打开。';
    try{await new Promise((resolve,reject)=>{const url=new URL('/v1/stream',location.origin);url.protocol='ws:';url.searchParams.set('token',window.localToken);const socket=new WebSocket(url);const timer=setTimeout(()=>{socket.close();reject(Error('模型准备超时，请检查网络后重试。'))},1200000);socket.onopen=()=>socket.send(JSON.stringify({type:'start',sample_rate:16000,language:'en',course_id:window.localCourseId}));socket.onmessage=e=>{const data=JSON.parse(e.data);if(data.type==='ready'){socket.send(JSON.stringify({type:'stop'}));clearTimeout(timer);socket.close();resolve()}else if(data.type==='error'){clearTimeout(timer);socket.close();reject(Error(data.error||data.message))}};socket.onerror=()=>{clearTimeout(timer);reject(Error('Whisper 服务无法连接'))};socket.onclose=()=>{clearTimeout(timer);reject(Error('模型准备连接已关闭'))}});await refreshHealth();toast('Whisper 模型已准备。')}catch(e){$('modelStatus').textContent=e.message}finally{$('prepareWhisper').disabled=false}
  };
  $('refreshModels').onclick=()=>refreshHealth().catch(e=>$('modelStatus').textContent=e.message);
  $('exportCorrections').onclick=async()=>{try{const data=await api('learning/export?course_id='+encodeURIComponent(window.localCourseId));downloadFile(JSON.stringify({...data,course: courses.find(c=>c.id===window.localCourseId)},null,2),'application/json','-课程纠错.json')}catch(e){toast(e.message)}};
  $('resetLearning').onclick=async()=>{if(!confirm('重置当前课程的术语与纠错记录？课堂录音与总结会保留。'))return;try{await post('learning/reset',{course_id:window.localCourseId});await refreshGlossary();await learningStatus();toast('本课程学习记录已重置。')}catch(e){toast(e.message)}};
  function courseOptions(){$('courseSelect').replaceChildren(...courses.map(course=>{const option=document.createElement('option');option.value=course.id;option.textContent=course.name;return option}));$('courseSelect').value=window.localCourseId}
  const courseDialog=document.createElement('dialog');courseDialog.id='courseDialog';courseDialog.className='modal';courseDialog.innerHTML='<form id="newCourseForm"><div class="modal-head"><h2>新课程</h2><button type="button" class="close-btn" id="cancelCourse" aria-label="关闭">×</button></div><div class="modal-body"><div class="field"><label for="courseName">课程名称</label><input id="courseName" maxlength="200" required placeholder="例如：Economics / 经济学"></div><button type="submit" class="btn primary" id="createCourse">创建课程</button></div></form>';document.body.append(courseDialog);
  $('addCourse').onclick=()=>{if(active)return;courseDialog.showModal();$('courseName').focus()};$('cancelCourse').onclick=()=>courseDialog.close();
  $('newCourseForm').onsubmit=async event=>{event.preventDefault();const name=$('courseName').value.trim();if(!name)return;$('createCourse').disabled=true;try{await window.localFlush();const course=await post('courses',{name});courses.push(course);window.localCourseId=course.id;localStorage.setItem('lc_desktop_course',course.id);courseOptions();clearClass();window.dispatchEvent(new Event('lecture-course-changed'));await refreshGlossary();await learningStatus();courseDialog.close();$('newCourseForm').reset()}catch(e){toast(e.message)}finally{$('createCourse').disabled=false}};
  $('courseSelect').onchange=async()=>{if(active||recognition?.closing){$('courseSelect').value=window.localCourseId;return toast('请先结束课堂并等待尾句。')}const next=$('courseSelect').value;try{await window.localFlush();window.localCourseId=next;localStorage.setItem('lc_desktop_course',next);clearClass();window.dispatchEvent(new Event('lecture-course-changed'));await refreshGlossary();await learningStatus();renderLibrary()}catch(e){$('courseSelect').value=window.localCourseId;toast(e.message)}};
  async function boot(){
    if(window.desktopSetup?.platform){window.localPlatform=await window.desktopSetup.platform();if(window.localPlatform.platform==='darwin'){$('asrDevice').querySelector('[value="cuda"]')?.remove();$('asrDevice').value='cpu';$('localSettings').querySelector('a[href*="ollama.com"]').href='https://ollama.com/download/mac';$('asrDevice').selectedOptions[0].textContent='Whisper 使用 CPU；LLM 由 Ollama 调用 Apple GPU（可用时）'}}
    try{courses=(await api('courses')).courses||[];if(!courses.length)courses.push(await post('courses',{name:'未分类课程'}));if(!courses.some(c=>c.id===window.localCourseId))window.localCourseId=courses[0].id;localStorage.setItem('lc_desktop_course',window.localCourseId);courseOptions();records=(await api('lectures')).lectures||[];booted=true;window.dispatchEvent(new Event('lecture-course-changed'));await refreshGlossary();await refreshHealth();updateCount();reliabilityNotice('本机 Whisper 转写与 LLM 翻译；首次请在设置中准备模型。');$('documentConsent').dispatchEvent(new Event('change'))}
    catch(e){$('connectionLabel').textContent='本机服务连接失败';reliabilityNotice('本机服务尚未就绪：'+e.message)}
  }
  // The website's network-only notices are replaced for actual offline use.
  window.addEventListener('offline',()=>reliabilityNotice('网络已断开；已下载的本机模型仍可运行。'));
  window.addEventListener('online',()=>reliabilityNotice('网络可用；课堂推理仍在本机进行。'));
  window.addEventListener('lecture-course-changed',()=>{$('connectionLabel').textContent='本机模式 · Whisper + Qwen'});
  boot();
})();
