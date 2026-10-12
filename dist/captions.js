/* One revisable draft, followed by committed captions. No draft is archived. */
class CaptionState {
  constructor(){this.reset('')}
  reset(session){this.session=session;this.sequence=-1;this.draft='';this.committed=new Set()}
  accept(update){
    if(update.session!==this.session||!Number.isInteger(update.sequence)||update.sequence<=this.sequence)return null;
    this.sequence=update.sequence;
    const stable=[];
    for(const segment of update.stable||[]){if(!segment||typeof segment.id!=='string'||typeof segment.text!=='string'||!segment.text.trim()||this.committed.has(segment.id))continue;this.committed.add(segment.id);stable.push(segment)}
    this.draft=typeof update.draft==='string'?update.draft:'';
    return {stable,draft:this.draft};
  }
}
if(typeof module!=='undefined')module.exports={CaptionState};
if(typeof document!=='undefined'){
  const captionState=new CaptionState();
  let browserSequence=0,lastBrowserSession='';
  window.beginCaptionSession=()=>{lastBrowserSession=studioOwner+':'+studioId;browserSequence=0;captionState.reset(lastBrowserSession);window.interimText=''};
  window.applyCaptionUpdate=update=>{
    if((!active&&!update.finalizing)||(paused&&!update.finalizing)||update.session!==studioOwner+':'+studioId)return;
    const accepted=captionState.accept(update);if(!accepted)return;
    for(const segment of accepted.stable){add(segment.text,$('source').value,segment.preset);const row=items[items.length-1];if(row&&Number.isFinite(segment.start))row.time=fmt(Math.floor(segment.start))}
    window.interimText=accepted.draft;render();
  };
  window.processBrowserCaptions=(event,sessionRecognition)=>{
    if(recognition!==sessionRecognition||(!active&&!sessionRecognition._captionClosing)||(paused&&!sessionRecognition._captionClosing))return;
    if(sessionRecognition._captionSession&&sessionRecognition._captionSession!==studioOwner+':'+studioId)return;
    const session=studioOwner+':'+studioId;if(lastBrowserSession!==session)window.beginCaptionSession();
    const stable=[];let draft='';
    // resultIndex is scoped to each recognition start; monitor supplies its epoch.
    const epoch=sessionRecognition._captionEpoch||0;
    for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i];if(result.isFinal)stable.push({id:epoch+':'+i,text:result[0].transcript,start:result.start,preset:typeof result.geminiTranslation==='string'?{translation:result.geminiTranslation,translationError:result.geminiTranslationError,translationMs:result.translationMs}:undefined});else if(active)draft+=result[0].transcript}
    window.applyCaptionUpdate({session,sequence:browserSequence++,stable,draft,finalizing:!!sessionRecognition._captionClosing});
  };
}
