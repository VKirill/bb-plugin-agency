import { parseDocument } from 'yaml';
export function parseDocumentProperties(content:string):{source:string|null;body:string;value:unknown;error:boolean}{
 const match=/^\uFEFF?---[ \t]*\r?\n([\s\S]*?)(?:^---[ \t]*|^\.\.\.[ \t]*)(?:\r?\n|$)/m.exec(content);
 // With /m the opener must still be at the start of the document.
 if(!match||match.index!==0)return {source:null,body:content,value:null,error:false};
 const source=match[1];const body=content.slice(match[0].length);
 try{
  if(source.length>65536)throw new Error('Frontmatter exceeds preview limit');
  const parsed=parseDocument(source,{stringKeys:true,uniqueKeys:true});
  if(parsed.errors.length||parsed.warnings.length)throw new Error('Invalid frontmatter');
  return {source,body,value:parsed.toJS({maxAliasCount:50}),error:false};
 }catch{return {source,body,value:null,error:true};}
}
