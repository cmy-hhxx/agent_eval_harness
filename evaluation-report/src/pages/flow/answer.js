(() => {
  'use strict';
  // A deliberately small, inert Markdown reader: source HTML and remote assets never execute.
  window.ReportAnswer={render(container,value){
    const document=container.ownerDocument;
    const element=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
    function inline(parent,text){
      let cursor=0;
      const pattern=/(`[^`\n]+`|\*\*[^*\n]+\*\*|!\[[^\]]*\]\([^\n)]+\)|\[[^\]]+\]\([^\n)]+\))/g;
      for(const match of text.matchAll(pattern)){
        parent.append(document.createTextNode(text.slice(cursor,match.index)));
        const token=match[0];
        if(token.startsWith('`'))parent.append(element('code',token.slice(1,-1)));
        else if(token.startsWith('**'))parent.append(element('strong',token.slice(2,-2)));
        else {const parts=token.match(/^(!?)\[([^\]]*)\]\(([^)]+)\)$/);parent.append(element('span',`${parts[1]?'图片：':''}${parts[2]} (${parts[3]})`));}
        cursor=match.index+token.length;
      }
      parent.append(document.createTextNode(text.slice(cursor)));
    }
    const rows=String(value).replaceAll('\r\n','\n').split('\n');
    const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(cell=>cell.trim());
    container.replaceChildren();
    for(let i=0;i<rows.length;){
      const line=rows[i];
      if(!line.trim()){i++;continue;}
      if(/^\s*```/.test(line)){
        const code=[];i++;while(i<rows.length&&!/^\s*```/.test(rows[i]))code.push(rows[i++]);if(i<rows.length)i++;
        const pre=element('pre');pre.append(element('code',code.join('\n')));container.append(pre);continue;
      }
      if(line.includes('|')&&/^\s*\|?\s*:?-{3,}/.test(rows[i+1]||'')&&cells(rows[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){
        const table=element('table'),thead=element('thead'),head=element('tr'),body=element('tbody');
        for(const cell of cells(line)){const th=element('th');inline(th,cell);head.append(th);}thead.append(head);i+=2;
        while(i<rows.length&&rows[i].includes('|')&&rows[i].trim()){const tr=element('tr');for(const cell of cells(rows[i++])){const td=element('td');inline(td,cell);tr.append(td);}body.append(tr);}
        table.append(thead,body);const wrap=element('div');wrap.className='table-wrap';wrap.append(table);container.append(wrap);continue;
      }
      const heading=line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
      if(heading){const h=element(`h${Math.min(heading[1].length+1,6)}`);inline(h,heading[2]);container.append(h);i++;continue;}
      if(/^\s*(?:---+|\*\*\*+)\s*$/.test(line)){container.append(element('hr'));i++;continue;}
      if(/^\s*[-*+]\s+/.test(line)){
        const ul=element('ul');while(i<rows.length&&/^\s*[-*+]\s+/.test(rows[i])){const li=element('li');inline(li,rows[i++].replace(/^\s*[-*+]\s+/,''));ul.append(li);}container.append(ul);continue;
      }
      const p=element(line.startsWith('>')?'blockquote':'p');inline(p,line.startsWith('>')?line.replace(/^>\s?/,''):line);container.append(p);i++;
    }
  }};
})();
