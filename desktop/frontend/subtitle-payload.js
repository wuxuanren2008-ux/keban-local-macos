/* Keep both subtitle lines attached to the same confirmed utterance. */
(function(root){
  function localSubtitlePayload(rows,draft,state){
    const valid=rows.filter(row=>typeof row.text==='string'&&row.text.trim());
    const completed=valid.filter(row=>row.translation&&!row._translating&&!/^（.*翻译/.test(row.translation));
    const row=completed.at(-1)||valid.at(-1);
    const pending=valid.filter(x=>!x.translation||x._translating).length;
    const status=state.paused?'已暂停':state.closing?'正在确认尾句':!state.active?'已结束 · 字幕已保留':pending?'本机翻译中 · '+pending+' 句等待':'正在聆听 · 本机 Whisper / LLM';
    return {original:(row?.text||draft||'等待视频或课堂声音…').slice(0,1200),translation:(row?.translation||'等待本机译文…').slice(0,1200),language:row?.code?.startsWith('ms')?'MS / 中文':row?.code?.startsWith('zh')?'中文 / EN':'EN / 中文',status};
  }
  if(typeof module==='object'&&module.exports)module.exports={localSubtitlePayload};else root.localSubtitlePayload=localSubtitlePayload;
})(globalThis);
