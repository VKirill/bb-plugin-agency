export interface QuestionField {
 id:string; prompt:string; multiSelect:boolean; allowFreeText:boolean;
 options?:{value:string;label:string;description?:string}[];
}
export type Answers = Record<string,{selected:string[];freeText?:string}>;
export interface TaskQuestion {
 id:string; kind:'user_question'|'secret_request'; status:'pending'|'resolved';
 questions:QuestionField[]; answers?:Answers; draft?:Answers;
}
export function validateAnswers(questions:QuestionField[],answers:Answers):string|null {
 for(const q of questions) {
  const a=answers[q.id]||{selected:[]};
  if(!a.selected.length&&!a.freeText?.trim())return `Ответьте: ${q.prompt}`;
  if(!q.multiSelect&&a.selected.length>1)return 'Для этого вопроса нужен один вариант.';
  if(a.selected.some(v=>!q.options?.some(o=>o.value===v)))return 'Выбран неизвестный вариант.';
  if(!q.allowFreeText&&a.freeText)return 'Этот вопрос не принимает произвольный текст.';
  if((a.freeText?.length||0)>16000)return 'Сократите ответ до 16 000 символов.';
 }
 if(Object.keys(answers).some(id=>!questions.some(q=>q.id===id)))return 'Ответ относится к другому вопросу.';
 return null;
}
export const designQuestion:TaskQuestion={id:'question-design-v1',kind:'user_question',status:'pending',questions:[
 {id:'style',prompt:'Какой стиль выбрать для изображений?',multiSelect:false,allowFreeText:true,options:[{value:'minimal',label:'Минимализм'},{value:'editorial',label:'Журнальная съёмка'},{value:'bright',label:'Яркая реклама'}]},
 {id:'formats',prompt:'Какие форматы подготовить?',multiSelect:true,allowFreeText:false,options:[{value:'square',label:'Квадрат 1:1'},{value:'portrait',label:'Вертикальный 9:16'},{value:'wide',label:'Горизонтальный 16:9'}]},
 {id:'constraints',prompt:'Что учесть в изображениях?',multiSelect:false,allowFreeText:true},
]};
