/** Browser-only projection. Matches are exact and case-sensitive, with longest matching text first. */
export type TransferMode = 'local' | 'original' | 'redacted';
export function projectText(text:string, mode:TransferMode, terms:string){
  if(mode==='local') throw Error('LOCAL_ONLY');
  if(mode==='original') return {text,replacements:0};
  const rules=[...new Set(terms.split(/\r?\n/).filter(Boolean))];
  if(!rules.length || rules.length>32 || rules.some(term=>term.length>256)) throw Error('INVALID_REDACTION_RULES');
  rules.sort((a,b)=>b.length-a.length);
  let offset=0, copies=0, output='';
  // Scan the original input exactly once. A replacement cannot itself match a later rule.
  while(offset<text.length){
    const match=rules.find(term=>text.startsWith(term,offset));
    if(match){output+='[已遮盖]';offset+=match.length;copies++;}
    else {output+=text[offset];offset++;}
  }
  return {text:output,replacements:copies};
}
