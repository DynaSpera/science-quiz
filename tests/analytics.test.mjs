import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeAttempts,chooseAttempts} from '../analytics.mjs';
const at=(id,name,score,maxScore,at,items,studentCode='')=>({id,studentName:name,studentCode,status:'submitted',score,maxScore,submittedAt:at,resultItems:items});
const ri=(questionId,isCorrect,earned,points,unit='힘과 운동')=>({questionId,isCorrect,earned,points,unit,prompt:'문제',selectedText:isCorrect?'정답':'오답'});
test('무작위 출제 문항의 정답률은 실제 출제 인원으로 계산',()=>{
 const a=[at('1','A',4,4,'2026-10-28T10:00:00Z',[ri('A',true,2,2),ri('B',true,2,2)]),at('2','B',0,2,'2026-10-28T10:01:00Z',[ri('B',false,0,2)])];
 const x=analyzeAttempts(a);
 assert.equal(x.items.find(i=>i.id==='A').rate,100);
 assert.equal(x.items.find(i=>i.id==='A').exposures,1);
 assert.equal(x.items.find(i=>i.id==='B').rate,50);
 assert.equal(x.items.find(i=>i.id==='B').exposures,2);
});
test('중복 응시는 최근 또는 최고점 기준',()=>{
 const a=[at('1','A',10,10,'2026-10-25T01:00:00Z',[ri('x',true,10,10)]),at('2','A',0,10,'2026-10-26T01:00:00Z',[ri('x',false,0,10)])];
 assert.equal(chooseAttempts(a,'latest')[0].id,'2');
 assert.equal(chooseAttempts(a,'highest')[0].id,'1');
 assert.equal(chooseAttempts(a,'all').length,2);
});
test('전체 풀이 결과가 없으면 0 점',()=>{
 const r=analyzeAttempts([]);assert.equal(r.summary.attempts,0);assert.equal(r.items.length,0);
});
test('변별도는 최소 5명 필요, 단일 문항에서는 계산 불가',()=>{
 const a=Array.from({length:5},(_,i)=>at(String(i),String(i),i%2,1,'2026-10-28T01:00:00Z',[ri('A',i%2===1,i%2,1)]));
 assert.equal(analyzeAttempts(a).items[0].discrimination,null);
});
