import { describe,it,expect } from 'vitest';
import { parseDocumentProperties } from '../src/app/prototype/document-properties-data';
describe('document frontmatter',()=>{
 it('preserves structured values and the unchanged Markdown body',()=>{
  const text='---\ntitle: Тест\npublished: false\ncount: 0\ntags: [Markdown, YAML]\nowner:\n  name: Кирилл\nsummary: |\n  Строка 1\n  Строка 2\n---\n# Текст\n';
  expect(parseDocumentProperties(text)).toMatchObject({body:'# Текст\n',error:false,value:{title:'Тест',published:false,count:0,tags:['Markdown','YAML'],owner:{name:'Кирилл'},summary:'Строка 1\nСтрока 2\n'}});
 });
 it('accepts BOM/CRLF and an empty header',()=>{
  expect(parseDocumentProperties('\uFEFF---\r\ntitle: Тест\r\n---\r\nТекст')).toMatchObject({body:'Текст',error:false,value:{title:'Тест'}});
  expect(parseDocumentProperties('---\n---\nТекст')).toMatchObject({body:'Текст',error:false});
 });
 it('leaves ordinary Markdown and incomplete headers intact',()=>{
  for(const content of ['# Текст\n---\ntitle: a\n---\n','---\ntitle: a'])expect(parseDocumentProperties(content)).toMatchObject({source:null,body:content});
 });
 it('keeps invalid YAML available without hiding the document',()=>{
  expect(parseDocumentProperties('---\ntitle: [invalid\n---\n# Текст')).toMatchObject({source:'title: [invalid\n',body:'# Текст',error:true});
 });
});
