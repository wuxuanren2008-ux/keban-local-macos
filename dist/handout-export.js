/* Local, editable OOXML and searchable PDF; no lecture content is uploaded. */
(function(root){
  'use strict';
  const safe=value=>String(value??'').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');
  const xml=value=>safe(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
  const filename=value=>safe(value).replace(/[<>:"/\\|?*]/g,'_').slice(0,160)||'课堂讲义';
  function block(type,text,group){return {type,text:safe(text),group}}
  function summaryBlocks(summary){
    if(!summary)return [];
    const rows=[block('heading','内容概要'),block('paragraph',summary.overview)];
    for(const [title,key] of [['核心要点','key_points'],['知识结构与学习建议','analysis'],['复习问题','review_questions'],['需要确认','unclear_points']])if(summary[key]?.length){rows.push(block('heading',title));for(const value of summary[key])rows.push(block('paragraph','• '+value))}
    if(summary.key_terms?.length){rows.push(block('heading','核心术语'));for(const term of summary.key_terms)rows.push(block('paragraph',term.term+'：'+term.explanation))}
    return rows;
  }
  function fromLecture(record,recording=false){
    const rows=[block('title',record.title||'课堂讲义')];
    if(recording)rows.push(block('note','课堂仍在录制，本讲义包含导出时已保存的内容。'));
    rows.push(...summaryBlocks(record.summary));
    if(record.notes)rows.push(block('heading','我的课堂笔记'),block('paragraph',record.notes));
    if(record.transcript?.length){rows.push(block('heading','双语课堂记录'));for(const [i,entry] of record.transcript.entries()){const group='lecture-'+i;rows.push(block('note','['+(entry.time||'00:00')+']'+(entry.bookmarked?' 重点':''),group),block('paragraph',entry.text,group),block('translation',entry.translation||'译文尚未完成。',group))}}
    return {title:record.title||'课堂讲义',blocks:rows};
  }
  function fromDocument(record){
    const rows=[block('title',(record.name||'学习资料').replace(/\.[^.]+$/,''))];
    if(record.status!=='complete')rows.push(block('note','部分处理结果：已完成 '+record.results.length+' / '+record.total+' 段，全篇分析尚未完成。'));
    rows.push(...summaryBlocks(record.summary));
    rows.push(block('heading','双语学习资料'));
    for(const section of record.results||[]){rows.push(block('heading',section.label||'正文'),block('paragraph',section.original),block('translation',section.translation));for(const warning of section.warnings||[])rows.push(block('note',warning))}
    const answers=Object.entries(record.answers||{}).filter(([,answer])=>answer);
    if(answers.length){rows.push(block('heading','我的复习作答'));for(const [i,answer] of answers)rows.push(block('paragraph',(Number(i)+1)+'. '+(record.summary?.review_questions?.[i]||'')),block('paragraph',answer))}
    return {title:(record.name||'学习资料').replace(/\.[^.]+$/,''),blocks:rows};
  }
  function validate(handout){
    const blocks=handout.blocks.filter(x=>x.text.trim());
    if(blocks.reduce((n,x)=>n+x.text.length,0)>600000)throw Error('讲义超过 600,000 字符，请分章节导出。');
    if(!blocks.length)throw Error('没有可导出的内容。');
    return {...handout,blocks};
  }
  function makeDocx(input,zip=root.fflate){
    const handout=validate(input);
    const paragraph=(row,index)=>'<w:p><w:pPr>'+(row.type==='title'?'<w:pStyle w:val="Title"/>':row.type==='heading'?'<w:pStyle w:val="Heading1"/><w:keepNext/>':'')+'<w:widowControl/><w:keepLines/>'+((row.group&&row.group===handout.blocks[index+1]?.group)?'<w:keepNext/>':'')+'<w:spacing w:after="140" w:line="300" w:lineRule="auto"/>'+(row.type==='note'?'<w:keepNext/>':'')+'</w:pPr>'+row.text.split('\n').map((line,i)=>'<w:r>'+((row.type==='title'||row.type==='heading')?'<w:rPr><w:b/></w:rPr>':'')+(i?'<w:br/>':'')+'<w:t xml:space="preserve">'+xml(line)+'</w:t></w:r>').join('')+'</w:p>';
    const document='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+handout.blocks.map(paragraph).join('')+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>';
    const styles='<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:color w:val="000000"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="140"/></w:pPr><w:rPr><w:b/><w:sz w:val="27"/></w:rPr></w:style></w:styles>';
    const files={
      '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
      '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      'word/document.xml':document,'word/styles.xml':styles,
      'word/_rels/document.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    };
    return zip.zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[key,zip.strToU8(value)])),{level:6});
  }
  async function makePdf(input,PDFLib,fontkit,fontBytes,latinBytes){
    const handout=validate(input),pdf=await PDFLib.PDFDocument.create();
    // Select the regular weight of the open variable Chinese font.
    pdf.registerFontkit({...fontkit,create:bytes=>{const font=fontkit.create(bytes);return font.variationAxes?.wght?font.getVariation({wght:400}):font}});
    const font=await pdf.embedFont(fontBytes,{subset:false}),width=595.28,height=841.89,margin=56.7,usable=width-2*margin;
    const fonts=[{font,supported:new Set(font.getCharacterSet())}];
    if(latinBytes){const extra=await pdf.embedFont(latinBytes,{subset:false});fonts.push({font:extra,supported:new Set(extra.getCharacterSet())})}
    const choose=char=>fonts.find(item=>item.supported.has(char.codePointAt(0)))?.font;
    if(handout.blocks.some(row=>Array.from(row.text).some(c=>c!=='\n'&&c!=='\t'&&!choose(c))))throw Error('PDF字体无法呈现部分字符，请改用Word导出以保留完整文字。');
    let page=pdf.addPage([width,height]),y=height-margin;page.setFont(font);
    const widths=new Map();
    const charWidth=(char,size)=>{const key=char+'|'+size;if(!widths.has(key))widths.set(key,choose(char).widthOfTextAtSize(char,size));return widths.get(key)};
    function draw(text,size){let x=margin,run='',current=null;const flush=()=>{if(!run)return;page.drawText(run,{x,y:y-size,size,...(current===font?{}:{font:current}),color:PDFLib.rgb(0,0,0)});x+=current.widthOfTextAtSize(run,size);run=''};for(const char of text){const next=choose(char);if(current&&next!==current)flush();current=next;run+=char}flush()}
    function newline(size){if(y-size<margin){if(pdf.getPageCount()>=300)throw Error('讲义超过 300 页，请分章节导出。');page=pdf.addPage([width,height]);page.setFont(font);y=height-margin}}
    function layout(row){
      const size=row.type==='title'?19:row.type==='heading'?13:row.type==='note'?9:11,lines=[];
      for(const paragraph of row.text.split('\n')){
        let line='',lineWidth=0;
        for(const char of paragraph.replace(/\t/g,'    ')){const next=charWidth(char,size);if(line&&lineWidth+next>usable-2){const at=line.lastIndexOf(' ');if(at>line.length/2){lines.push(line.slice(0,at));line=line.slice(at+1);lineWidth=Array.from(line).reduce((sum,c)=>sum+charWidth(c,size),0)}else{lines.push(line);line='';lineWidth=0}}line+=char;lineWidth+=next}lines.push(line);
      }
      return {row,size,lines,lineHeight:size*1.55,height:lines.length*size*1.55+7+(row.type==='heading'?9:0)};
    }
    const layouts=handout.blocks.map(layout);
    for(let i=0;i<layouts.length;i++){
      const item=layouts[i],{row,size,lines,lineHeight}=item;
      if(!row.group||i===0||layouts[i-1].row.group!==row.group){let required=item.height;
        if(row.group)for(let j=i+1;j<layouts.length&&layouts[j].row.group===row.group;j++)required+=layouts[j].height;
        else if(row.type==='heading'&&layouts[i+1])required+=Math.min(layouts[i+1].height,layouts[i+1].lineHeight*2);
        if(required<=height-2*margin)newline(required);
      }
      if(row.type==='heading')y-=9;
      for(let n=0;n<lines.length;n++){if(lines.length-n===2)newline(lineHeight*2);newline(lineHeight);draw(lines[n],size);y-=lineHeight}
      y-=7;
    }
    pdf.setTitle(handout.title);pdf.setCreator('课伴');pdf.setProducer('课伴本机讲义导出');
    return pdf.save();
  }
  let fontPromise,scriptPromise;
  async function pdfDependencies(){
    if(!root.fontkit){scriptPromise||=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='vendor/fontkit-1.1.1.min.js';script.onload=resolve;script.onerror=()=>{scriptPromise=null;reject(Error('PDF组件加载失败，请重试。'))};document.head.append(script)});await scriptPromise}
    fontPromise||=Promise.all(['NotoSansSC.ttf','NotoSans.ttf'].map(name=>fetch('vendor/'+name).then(response=>{if(!response.ok)throw Error('字体加载失败。');return response.arrayBuffer()}))).catch(error=>{fontPromise=null;throw error});
    return (await fontPromise).map(bytes=>new Uint8Array(bytes));
  }
  async function download(input,format,valid=()=>true){
    const handout=validate(input);
    if(format!=='docx'&&format!=='pdf')throw Error('不支持此讲义格式。');
    let bytes;if(format==='docx')bytes=makeDocx(handout);else{const [chinese,latin]=await pdfDependencies();bytes=await makePdf(handout,root.PDFLib,root.fontkit,chinese,latin)}
    if(!valid())return;
    const blob=new Blob([bytes],{type:format==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename(handout.title)+'-讲义.'+format;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  const api={fromLecture,fromDocument,makeDocx,makePdf,download,validate};root.HandoutExport=api;
  if(typeof module!=='undefined')module.exports=api;
  if(typeof document!=='undefined'){
    for(const id of ['exportFormat','documentExportFormat']){const select=document.getElementById(id);if(select)for(const [value,text] of [['docx','Word 讲义 DOCX'],['pdf','PDF 讲义']]){const option=document.createElement('option');option.value=value;option.textContent=text;select.append(option)}}
    const button=document.getElementById('saveNotes'),original=button?.onclick;
    if(button)button.onclick=async()=>{const format=document.getElementById('exportFormat').value;if(!['docx','pdf'].includes(format))return original?.();const owner=studioOwner,id=studioId;button.disabled=true;try{toast('正在本机生成讲义…');await download(fromLecture(snapshotClass(),active),format,()=>studioOwner===owner&&studioId===id)}catch(error){toast('导出失败：'+error.message)}finally{updateCount()}};
  }
})(typeof window!=='undefined'?window:globalThis);
