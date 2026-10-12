/* File preparation is local; no provider receives data until explicit AI consent. */
(function(root){
  'use strict';
  const MAX_FILE=10*1024*1024,MAX_TEXT=120000,CHUNK=6000;
  function validateFile(file){
    if(!file||!file.size)throw Error('请选择有内容的文件。');
    if(file.size>MAX_FILE)throw Error('文件超过 10 MB，请拆分后上传。');
    const ext=file.name.split('.').pop().toLowerCase();
    if(!['pdf','txt','md','docx','pptx'].includes(ext))throw Error('支持 PDF、TXT、Markdown、DOCX 和 PPTX；旧版 DOC/PPT 请先转换。');
    return ext;
  }
  function splitText(text,label='正文'){
    if(typeof text!=='string'||!text.trim())throw Error('没有可读取的文字。请将扫描资料另存为 PDF。');
    if(text.length>MAX_TEXT)throw Error('正文超过 120,000 字符，请拆分后上传；未截取文件。');
    const chunks=[];let offset=0;
    while(offset<text.length){let end=Math.min(offset+CHUNK,text.length);if(end<text.length){const newline=text.lastIndexOf('\n',end);if(newline>offset+CHUNK/2)end=newline+1;if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;}chunks.push({label:label+' · 第 '+(chunks.length+1)+' 段',text:text.slice(offset,end)});offset=end;}
    return chunks;
  }
  function xmlText(bytes,tag){
    const raw=new TextDecoder().decode(bytes);
    if(/<!DOCTYPE|<!ENTITY/i.test(raw))throw Error('资料 XML 包含不支持的实体声明。');
    const xml=new DOMParser().parseFromString(raw,'application/xml');
    if(xml.getElementsByTagName('parsererror').length)throw Error('文件正文格式损坏。');
    return Array.from(xml.getElementsByTagNameNS('*',tag)).map(p=>Array.from(p.getElementsByTagNameNS('*','t')).map(t=>t.textContent).join('')).filter(Boolean).join('\n');
  }
  async function prepareFile(file){
    const ext=validateFile(file),bytes=new Uint8Array(await file.arrayBuffer());
    if(ext==='pdf'){
      if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('这不是有效 PDF 文件。');
      let pdf;try{pdf=await root.PDFLib.PDFDocument.load(bytes)}catch{throw Error('PDF 已加密或损坏，请解密或重新导出。')}
      const pages=pdf.getPageCount();if(!pages||pages>60)throw Error('PDF 支持 1–60 页；请按章节拆分。');
      const chunks=[];
      // Single-page requests make coverage explicit and scanned PDF processing bounded.
      for(let i=0;i<pages;i++){
        const part=await root.PDFLib.PDFDocument.create();const [page]=await part.copyPages(pdf,[i]);part.addPage(page);
        const data=await part.saveAsBase64();if(data.length>5600000)throw Error('PDF 第 '+(i+1)+' 页超过处理限额，请压缩图片后重试。');
        chunks.push({label:'第 '+(i+1)+' 页',pdf:data});
      }
      return {name:file.name,type:ext,chunks,notice:pages+' 页 · 包含扫描页、图表及公式；AI 无法辨认的区域会标注。'};
    }
    if(ext==='txt'||ext==='md'){
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('文字文件须为 UTF-8 编码，请另存为 UTF-8 后重试。')}
      if(text.includes('\u0000'))throw Error('文字文件含二进制内容，无法读取。');
      return {name:file.name,type:ext,chunks:splitText(text),notice:text.length.toLocaleString()+' 字符 · 完整分段处理'};
    }
    let expanded=0;
    const entries=root.fflate.unzipSync(bytes,{filter(entry){
      expanded+=entry.originalSize;if(expanded>40*1024*1024||entry.originalSize>10*1024*1024)throw Error('文件解压后过大，请简化或拆分资料。');
      return ext==='docx'?entry.name==='word/document.xml':/^ppt\/slides\/slide\d+\.xml$/.test(entry.name);
    }});
    let chunks=[];
    if(ext==='docx'){
      if(!entries['word/document.xml'])throw Error('Word 文件缺少正文。');chunks=splitText(xmlText(entries['word/document.xml'],'p'));
    }else{
      const names=Object.keys(entries).sort((a,b)=>Number(a.match(/slide(\d+)/)[1])-Number(b.match(/slide(\d+)/)[1]));
      if(!names.length||names.length>120)throw Error('PPTX 支持 1–120 页。');let length=0;
      for(let i=0;i<names.length;i++){const text=xmlText(entries[names[i]],'p');length+=text.length;if(length>MAX_TEXT)throw Error('课件正文超过 120,000 字符，请拆分。');if(text.trim())chunks.push(...splitText(text,'课件第 '+(i+1)+' 页'));}
      if(!chunks.length)throw Error('课件没有文字；图片型课件请导出为 PDF。');
    }
    if(chunks.length>60)throw Error('资料分段超过 60 段，请拆分后上传。');
    return {name:file.name,type:ext,chunks,notice:'已提取正文文字；Office 图片、公式和复杂表格请导出 PDF 以保留完整内容。'};
  }
  function validateTranslation(value){
    if(!value||typeof value.original!=='string'||typeof value.translation!=='string'||typeof value.digest!=='string'||!Array.isArray(value.warnings)||value.warnings.some(x=>typeof x!=='string'))throw Error('AI 返回格式不完整，请重试当前段落。');
    if(!value.translation.trim())throw Error('AI 未返回译文，请重试当前段落。');return value;
  }
  function exportMarkdown(record){
    const s=record.summary;return ['# '+record.name,'','状态：'+(record.status==='complete'?'完整翻译与分析已完成':'部分完成')+' · 已翻译 '+record.results.length+' / '+record.total+' 段','目标语言：'+record.language,'',...(s?['## 内容概要',s.overview,'','## 核心要点',...s.key_points.map(x=>'- '+x),'','## 术语',...s.key_terms.map(x=>'- '+x.term+'：'+x.explanation),'','## 自测',...s.review_questions.map(x=>'- '+x),'','## 分析',...s.analysis.map(x=>'- '+x),'','## 待确认',...s.unclear_points.map(x=>'- '+x),'']:[]),'## 双语翻译','',...record.results.flatMap(x=>['### '+x.label,'','原文：',x.original||'本页没有可辨认的正文。','','译文：',x.translation,'',...x.warnings.map(w=>'> '+w),''])].join('\n');
  }
  root.DocumentStudy={validateFile,splitText,prepareFile,validateTranslation,exportMarkdown};
  if(typeof module!=='undefined')module.exports=root.DocumentStudy;
})(typeof window!=='undefined'?window:globalThis);
