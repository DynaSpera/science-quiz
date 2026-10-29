import { analyzeAttempts } from './analytics.mjs';

const cfg = window.SCIENCE_QUIZ_CONFIG || {};
const connected = !!(cfg.supabaseUrl && cfg.supabasePublishableKey);
let supabase = null;
const $ = (id) => document.getElementById(id);
const state = { catalog:null, demoQuestions:[], current:null, selectedIndex:null, collected:{}, results:null, attempts:[], report:null, bank:[], token:null, viewingTeacher:false, demoSeeded:false };
const DEMO_RESULTS_KEY = 'science-quiz-demo-attempts-v1';
const PROGRESS_KEY = 'science-quiz-active-attempt-v2';
const LAST_PAGE_KEY = 'science-quiz-last-page-v2';
const LAST_TAB_KEY = 'science-quiz-last-admin-tab-v2';
let fallbackDemoAttempts = [];

function show(el, yes=true){$(el).classList.toggle('hidden',!yes);}
function msg(id, value){$(id).textContent=value||'';}
function toast(message){msg('toast',message);show('toast',true);clearTimeout(toast.t);toast.t=setTimeout(()=>show('toast',false),4500);}
function textCell(row,value){const td=document.createElement('td');td.textContent=String(value??'—');row.appendChild(td);return td;}
function fmtDate(v){if(!v)return '—'; const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString('ko-KR',{hour12:false});}
function byId(id){return state.demoQuestions.find(q=>q.id===id);}
function fisher(items){const arr=[...items];for(let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}return arr;}
const escCsv=(x)=>{const v=String(x??'');const safe=/^[=+\-@\t\r]/.test(v)?`'${v}`:v;return '"'+safe.replaceAll('"','""')+'"';};
function saveCSV(rows,filename){if(!rows.length){toast('저장할 자료가 없습니다.');return;}const keys=Object.keys(rows[0]);const csv='\ufeff'+[keys.map(escCsv).join(','),...rows.map(r=>keys.map(k=>escCsv(r[k])).join(','))].join('\r\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}

function saveProgress(){
 if(!state.current)return;
 try{sessionStorage.setItem(PROGRESS_KEY,JSON.stringify({current:state.current,collected:state.collected,selectedIndex:state.selectedIndex,savedAt:Date.now()}));}catch{/* 스토리지 비활성 환경에서는 이어 풀기 미지원 */}
}
function clearProgress(){try{sessionStorage.removeItem(PROGRESS_KEY);}catch{/* no-op */}show('resume-offer',false);}
function findSavedProgress(){
 try{const p=JSON.parse(sessionStorage.getItem(PROGRESS_KEY)||'null');
  if(!p?.current?.id||!Array.isArray(p.current.questions)||!p.current.questions.length)return null;
  if(Date.now()-Number(p.savedAt)>86400000){clearProgress();return null;}return p;
 }catch{return null;}
}
function offerResume(){const p=findSavedProgress();if(!p)return;msg('resume-description',`${p.current.name||'학생'} · ${p.current.questions.length}문항 중 ${p.current.index+1}번째 문제부터 이어 풀 수 있어요. (현재 브라우저에서만 복원)`);show('resume-offer');}
function resumeQuiz(){const p=findSavedProgress();if(!p){toast('복원할 퀴즈가 없습니다.');return;}
 state.current=p.current;state.collected=p.collected||{};state.selectedIndex=p.selectedIndex??null;
 show('student-setup',false);show('result-stage',false);show('quiz-stage');renderQuestion();
 toast('이전 퀴즈를 복원했습니다.');
}
function restorePageView(){
 let lastPage='student',lastTab='dashboard';
 try{lastPage=sessionStorage.getItem(LAST_PAGE_KEY)||'student';lastTab=sessionStorage.getItem(LAST_TAB_KEY)||'dashboard';}catch{}
 navigate(lastPage==='teacher'?'teacher':'student');
 if(['dashboard','items','students','bank'].includes(lastTab))tabSwitch(lastTab);
 offerResume();updateAvailableCount();
}
function updateAvailableCount(){
 const unit=$('unit-select').value,difficulty=$('difficulty-select').value;
 let count=0;
 if(connected)count=(state.catalog?.counts||[]).filter(q=>(unit==='all'||q.unit===unit)&&(difficulty==='all'||q.difficulty===difficulty)).reduce((a,q)=>a+q.count,0);
 else count=state.demoQuestions.filter(q=>q.active!==false&&(unit==='all'||q.unit===unit)&&(difficulty==='all'||q.difficulty===difficulty)).length;
 msg('available-count',`출제 가능 ${count}문항`);
 const year=connected?(state.catalog?.academicYear||'설정 확인 필요'):new Date().getFullYear();
 msg('academic-year-info',`학년도 ${year} · `);
}
async function refreshCatalog(){
 if(connected){state.catalog=await api('catalog');populateUnits(state.catalog.units);}else populateUnits([...new Set(state.demoQuestions.filter(q=>q.active!==false).map(q=>q.unit))]);
 updateAvailableCount();
}
function personalCsvRows(attempt){return (attempt.resultItems||[]).map(item=>({
 '학생':attempt.studentName||'', '학번':attempt.studentCode||'', '학년도':attempt.academicYear||'',
 '문항ID':item.questionId, '단원':item.unit, '난이도':item.difficulty, '문제':item.prompt,
 '내 답':item.selectedText,'정답':item.correctText,'정오':item.isCorrect?'O':'X',
 '획득점수':item.earned,'배점':item.points,'해설':item.explanation,
 '최종점수':attempt.score,'만점':attempt.maxScore,'제출시각':attempt.submittedAt
}));}
function safeFilePiece(v){return String(v||'학생').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,50);}
function downloadStudentCsv(id){
 if(connected&&!state.token){toast('교사 로그인이 필요합니다.');return;}
 const attempt=state.attempts.find(a=>a.id===id&&a.status==='submitted');
 if(!attempt){toast('해당 응시를 찾지 못했습니다.');return;}
 const code=safeFilePiece([attempt.academicYear||'',attempt.studentCode||'',attempt.studentName||''].filter(Boolean).join('_'));
 const stamp=String(attempt.submittedAt||'').replace(/[^0-9]/g,'').slice(0,14)||'미상';
 saveCSV(personalCsvRows(attempt),`과학퀴즈_${code}_${stamp}_${safeFilePiece(String(attempt.id).slice(0,8))}.csv`);
}

function demoAttempts(){try{return JSON.parse(localStorage.getItem(DEMO_RESULTS_KEY)||'[]');}catch{return fallbackDemoAttempts;}}
function persistDemo(a){const v=demoAttempts();v.push(a);fallbackDemoAttempts=v.slice(-300);try{localStorage.setItem(DEMO_RESULTS_KEY,JSON.stringify(fallbackDemoAttempts));}catch{/* 저장소 제한 환경에서는 메모리에만 보관 */}}
function sampleAttempts(){const names=['샘플01','샘플02','샘플03','샘플04','샘플05','샘플06','샘플07','샘플08'];return names.map((name,index)=>{const qs=fisher(state.demoQuestions).slice(0,10);const resultItems=qs.map((q,j)=>{const isCorrect=(index+j*3)%5!==0;const selectedIndex=isCorrect?q.correctIndex:(q.correctIndex+1)%q.choices.length;return {questionId:q.id,unit:q.unit,difficulty:q.difficulty,prompt:q.prompt,selectedIndex,selectedText:q.choices[selectedIndex],correctIndex:q.correctIndex,correctText:q.choices[q.correctIndex],isCorrect,earned:isCorrect?q.points:0,points:q.points,explanation:q.explanation};});const score=resultItems.reduce((s,r)=>s+r.earned,0),maxScore=resultItems.reduce((s,r)=>s+r.points,0);return {id:`demo-sample-${index}`,studentCode:`S${String(index+1).padStart(3,'0')}`,studentName:name,status:'submitted',score,maxScore,resultItems,submittedAt:new Date(Date.now()-index*3600000).toISOString()};});}

async function api(action,payload=null,token=null){
 if(!connected)throw new Error('데모 모드에서는 서버에 연결되지 않습니다.');
 const base=cfg.supabaseUrl.replace(/\/$/,'');
 const url=`${base}/functions/v1/${encodeURIComponent(cfg.functionName||'quiz-api')}/${action}`;
 const headers={'apikey':cfg.supabasePublishableKey,'content-type':'application/json'};
 if(token)headers.authorization=`Bearer ${token}`;
 const res=await fetch(url,{method:payload===null?'GET':'POST',headers,body:payload===null?undefined:JSON.stringify(payload)});
 let data;try{data=await res.json();}catch{throw new Error(`서버 응답 오류 (${res.status})`);}
 if(!res.ok)throw new Error(data.error||`요청 실패 (${res.status})`);
 return data;
}

async function init(){
 if(connected){
  $('connection-status').textContent='온라인 연결 준비';
  try{const mod=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');supabase=mod.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey);supabase.auth.onAuthStateChange((_event,session)=>{state.token=session?.access_token||null;});const catalog=await api('catalog');state.catalog=catalog;populateUnits(catalog.units);msg('connection-status','온라인 연결');const {data}=await supabase.auth.getSession();if(data.session?.access_token){state.token=data.session.access_token;await loadAdmin();}}catch(err){msg('connection-status','서버 연결 오류');msg('quiz-error',err.message);toast(`연결 실패: ${err.message}`);$('start-button').disabled=true;}
 }else{
  $('connection-status').textContent='체험 모드';$('connection-status').classList.add('demo');show('demo-banner');show('demo-login');
  try{state.demoQuestions=await (await fetch('./data/sample-questions.json')).json();populateUnits([...new Set(state.demoQuestions.map(q=>q.unit))]);}catch(err){toast('샘플 문항 로딩에 실패했습니다. GitHub Pages 또는 로컬 서버에서 실행하세요.');$('start-button').disabled=true;}
 }
 bindEvents();restorePageView();
}
function populateUnits(units){const select=$('unit-select');while(select.options.length>1)select.remove(1);for(const u of [...units].sort((a,b)=>a.localeCompare(b,'ko'))){const o=document.createElement('option');o.value=u;o.textContent=u;select.append(o);}}
function navigate(page){const teacher=page==='teacher';try{sessionStorage.setItem(LAST_PAGE_KEY,teacher?'teacher':'student');}catch{}show('student-page',!teacher);show('teacher-page',teacher);$('nav-student').classList.toggle('selected',!teacher);$('nav-teacher').classList.toggle('selected',teacher);state.viewingTeacher=teacher;window.scrollTo(0,0);}
function renderQuestion(){const quiz=state.current, idx=quiz.index, q=quiz.questions[idx];state.selectedIndex=Number.isInteger(state.collected[q.id])?state.collected[q.id]:null;
 msg('question-number',String(idx+1).padStart(2,'0'));msg('question-unit',q.unit);msg('question-difficulty',`난이도 · ${q.difficulty}  |  배점 · ${q.points}점`);msg('quiz-title',q.prompt);msg('question-progress',`${idx+1} / ${quiz.questions.length}`);$('progress-fill').style.width=`${(idx/quiz.questions.length)*100}%`;$('progress-track').setAttribute('aria-valuenow',String(Math.round(idx/quiz.questions.length*100)));
 const list=$('option-list');list.replaceChildren();q.options.forEach((opt,i)=>{const btn=document.createElement('button');btn.className='option-button';btn.type='button';btn.setAttribute('role','radio');btn.setAttribute('aria-checked',String(i===state.selectedIndex));const n=document.createElement('span');n.className='option-index';n.textContent=String(i+1);const txt=document.createElement('span');txt.textContent=opt;btn.append(n,txt);btn.onclick=()=>{state.selectedIndex=i;for(const b of list.children)b.setAttribute('aria-checked',String(b===btn));state.collected[q.id]=i;saveProgress();};list.appendChild(btn);});msg('quiz-error','');msg('next-button',idx===quiz.questions.length-1?'결과 제출하기 ↗':'다음 문제 →');}
async function beginQuiz(e){e.preventDefault();const name=$('student-name').value.trim();const code=$('student-code').value.trim();if(!name){toast('이름 또는 별칭을 입력하세요.');return;}if(!code){toast('학번을 입력하세요.');return;}const payload={studentName:name,studentCode:code,unit:$('unit-select').value,difficulty:$('difficulty-select').value,count:Number($('count-select').value),mode:$('quiz-mode').value,accessCode:$('quiz-code').value};$('start-button').disabled=true;
 try{
  let result;
  if(connected){result=await api('start',payload);}else{
   const filtered=state.demoQuestions.filter(q=>q.active!==false&&(payload.unit==='all'||q.unit===payload.unit)&&(payload.difficulty==='all'||q.difficulty===payload.difficulty));if(!filtered.length)throw new Error('선택 조건에 맞는 문제가 없습니다.');
   const questions=(payload.mode==='fixed'?[...filtered].sort((a,b)=>a.id.localeCompare(b.id)):fisher(filtered)).slice(0,payload.count).map(q=>{const choices=fisher(q.choices.map((text,index)=>({text,index})));return {id:q.id,unit:q.unit,difficulty:q.difficulty,prompt:q.prompt,points:q.points,options:choices.map(c=>c.text)};});
   result={attemptId:crypto.randomUUID(),questions};
  }
  if(!result.questions?.length)throw new Error('출제할 문제가 없습니다. 문제은행을 확인하세요.');
  clearProgress();state.current={id:result.attemptId,questions:result.questions,index:0,name,code,academicYear:state.catalog?.academicYear||new Date().getFullYear()};state.collected={};state.results=null;saveProgress();if(result.questions.length<payload.count)toast(`${payload.count}문항 요청 중 출제 가능한 ${result.questions.length}문항으로 진행합니다.`);show('student-setup',false);show('result-stage',false);show('quiz-stage');renderQuestion();
 }catch(err){toast(err.message);}finally{$('start-button').disabled=false;}}
async function nextQuestion(){const q=state.current?.questions[state.current.index];if(!q)return;if(state.selectedIndex===null){msg('quiz-error','답안을 하나 선택하세요.');return;}state.collected[q.id]=state.selectedIndex;saveProgress();if(state.current.index<state.current.questions.length-1){state.current.index++;saveProgress();renderQuestion();return;}
 $('next-button').disabled=true;msg('quiz-error','결과를 제출하고 있습니다…');
 try{
  let result;
  if(connected){result=await api('submit',{attemptId:state.current.id,answers:state.collected});}else{
   const items=state.current.questions.map(q=>{const raw=byId(q.id);const selectedIndex=state.collected[q.id],selectedText=q.options[selectedIndex],correctText=raw.choices[raw.correctIndex],correctIndex=q.options.indexOf(correctText),isCorrect=selectedText===correctText;return {questionId:q.id,unit:q.unit,difficulty:q.difficulty,prompt:q.prompt,selectedIndex,selectedText,correctIndex,correctText,isCorrect,earned:isCorrect?q.points:0,points:q.points,explanation:raw.explanation};});
   const score=items.reduce((s,i)=>s+i.earned,0),maxScore=items.reduce((s,i)=>s+i.points,0);
   const attempt={id:state.current.id,studentName:state.current.name,studentCode:state.current.code,status:'submitted',submittedAt:new Date().toISOString(),score,maxScore,resultItems:items};persistDemo(attempt);result=attempt;
  }
  state.results=result;clearProgress();renderResult(result);show('quiz-stage',false);show('result-stage');window.scrollTo(0,250);
 }catch(err){msg('quiz-error',`제출 실패: ${err.message} · 답안은 현재 화면에 남아 있습니다.`);}finally{$('next-button').disabled=false;}}
function renderResult(r){msg('result-score',`${r.score} / ${r.maxScore}`);msg('submission-message',connected?'✓ 결과가 서버에 자동 제출되었습니다.':'데모: 이 브라우저에만 저장되었습니다.');const correct=r.resultItems.filter(i=>i.isCorrect).length;const metrics=[['정답 수',`${correct} / ${r.resultItems.length}`],['성취율',`${r.maxScore?Math.round(r.score/r.maxScore*100):0}%`],['틀린 문제',`${r.resultItems.length-correct}문항`]];$('result-metrics').replaceChildren();for(const [label,value] of metrics){const box=document.createElement('div');box.className='metric';const small=document.createElement('small');small.textContent=label;const strong=document.createElement('strong');strong.textContent=value;box.append(small,strong);$('result-metrics').append(box);}
 $('review-list').replaceChildren();r.resultItems.forEach((item,index)=>{const div=document.createElement('div');div.className='review-item';const strong=document.createElement('strong');strong.textContent=`${index+1}. ${item.prompt}`;const mine=document.createElement('p');mine.className=item.isCorrect?'right':'wrong';mine.textContent=`내 답: ${item.selectedText}  ·  ${item.isCorrect?'정답':'오답'} (${item.earned}/${item.points}점)`;const correct=document.createElement('p');correct.textContent=`정답: ${item.correctText}`;const exp=document.createElement('p');exp.className='muted';exp.textContent=item.explanation||'해설 없음';div.append(strong,mine,correct,exp);$('review-list').append(div);});}
function downloadPersonal(){const r=state.results;if(!r)return;saveCSV(personalCsvRows({...r,studentName:state.current.name,studentCode:state.current.code,academicYear:state.current.academicYear}),`과학퀴즈_${state.current.code||state.current.name}_결과.csv`);}
function retry(){clearProgress();state.current=null;state.results=null;state.collected={};show('student-setup');show('quiz-stage',false);show('result-stage',false);window.scrollTo(0,200);}

async function loginTeacher(e){e.preventDefault();msg('login-error','');$('login-button').disabled=true;try{if(!supabase)throw new Error('데모 체험 버튼을 사용하세요.');const {data,error}=await supabase.auth.signInWithPassword({email:$('teacher-email').value.trim(),password:$('teacher-password').value});if(error)throw error;state.token=data.session.access_token;await loadAdmin();}catch(err){msg('login-error',err.message);}finally{$('login-button').disabled=false;}}
async function loadAdmin(){try{if(connected){const data=await api('admin-report',null,state.token);state.attempts=data.attempts||[];}else{state.attempts=[...sampleAttempts(),...demoAttempts()];}populateReportFilters();updateReport();show('teacher-login',false);show('admin-workspace');renderAdmin();msg('admin-error','');}catch(err){state.token=null;show('teacher-login');show('admin-workspace',false);msg('login-error',err.message);}}
function tabSwitch(tab){try{sessionStorage.setItem(LAST_TAB_KEY,tab);}catch{}for(const b of document.querySelectorAll('[data-admin-tab]')){const selected=b.dataset.adminTab===tab;b.classList.toggle('active',selected);b.setAttribute('aria-selected',String(selected));}for(const t of ['dashboard','items','students','bank'])show(`admin-${t}`,t===tab);}
function tableRows(bodyId,rows,cols){const tbody=$(bodyId);tbody.replaceChildren();if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.className='empty-state';td.colSpan=cols.length;td.textContent='아직 분석할 데이터가 없습니다.';tr.append(td);tbody.append(tr);return;}for(const row of rows){const tr=document.createElement('tr');for(const col of cols)textCell(tr,typeof col==='function'?col(row):row[col]);tbody.append(tr);}}
function filteredAttempts(){
 const year=$('filter-year').value,unit=$('filter-unit').value,query=$('filter-student').value.trim().toLowerCase();
 return state.attempts.filter(a=>(year==='all'||String(a.academicYear||String(a.submittedAt||'').slice(0,4))===year)
   &&($('include-test').checked||!a.isTest)
   &&(!query||`${a.studentName||''} ${a.studentCode||''}`.toLowerCase().includes(query))
   &&(unit==='all'||(a.resultItems||[]).some(r=>r.unit===unit)))
   .map(a=>{
      if(unit==='all')return a;
      const resultItems=(a.resultItems||[]).filter(r=>r.unit===unit);
      return {...a,resultItems,score:resultItems.reduce((sum,r)=>sum+(Number(r.earned)||0),0),maxScore:resultItems.reduce((sum,r)=>sum+(Number(r.points)||0),0)};
   });
}

function populateReportFilters(){
 const yearSelect=$('filter-year'),unitSelect=$('filter-unit');
 const previousYear=yearSelect.value,previousUnit=unitSelect.value;
 const years=[...new Set(state.attempts.map(a=>String(a.academicYear||String(a.submittedAt||'').slice(0,4))).filter(Boolean))].sort().reverse();
 const units=[...new Set(state.attempts.flatMap(a=>(a.resultItems||[]).map(r=>r.unit)).filter(Boolean))].sort();
 for(const [select,values,defaultText] of [[yearSelect,years,'전체 학년도'],[unitSelect,units,'전체 단원']]){
  select.replaceChildren();const all=document.createElement('option');all.value='all';all.textContent=defaultText;select.append(all);
  for(const value of values){const opt=document.createElement('option');opt.value=value;opt.textContent=value;select.append(opt);}
 }
 yearSelect.value=years.includes(previousYear)?previousYear:'all';unitSelect.value=units.includes(previousUnit)?previousUnit:'all';
}
function updateReport(){
 state.report=analyzeAttempts(filteredAttempts(),$('attempt-policy').value,state.attempts);
 msg('filter-caption',`필터 적용: ${state.report.summary.attempts}건 · 테스트 ${$('include-test').checked?'포함':'제외'} · 중복 처리 ${$('attempt-policy').selectedOptions[0]?.textContent||''}`);
 renderAdmin();
}
function renderAdmin(){const r=state.report;if(!r)return;const cards=[['분석 응시',`${r.summary.attempts}건`,'중복 정책 반영'],['참여 학생',`${r.summary.uniqueStudents}명`,'학번·이름 기준'],['평균 성취율',`${r.summary.average}%`,'응시별 백분율 평균'],['문항 종류',`${r.summary.questionCount}개`,'실제 출제된 문항']];$('summary-cards').replaceChildren();for(const [label,value,small] of cards){const div=document.createElement('div');div.className='stat-card';const span=document.createElement('span');span.textContent=label;const strong=document.createElement('strong');strong.textContent=value;const s=document.createElement('small');s.textContent=small;div.append(span,strong,s);$('summary-cards').append(div);}
 $('unit-bars').replaceChildren();for(const u of r.units){const wrap=document.createElement('div');const lab=document.createElement('div');lab.className='bar-label';const n=document.createElement('span');n.textContent=u.unit;const v=document.createElement('span');v.textContent=`${u.rate}%`;lab.append(n,v);const track=document.createElement('div');track.className='bar-track';const fill=document.createElement('span');fill.style.width=`${Math.max(0,Math.min(100,u.rate))}%`;track.append(fill);wrap.append(lab,track);$('unit-bars').append(wrap);}if(!r.units.length)msg('unit-bars','아직 결과가 없습니다.');
 $('hard-items').replaceChildren();for(const q of [...r.items].filter(q=>q.rate<100).sort((a,b)=>a.rate-b.rate).slice(0,5)){const div=document.createElement('div');div.className='compact-item';const s=document.createElement('span');s.textContent=`${q.label||q.id} · ${q.unit} (응시 ${q.exposures}명${q.exposures<5?' · 표본 부족':''})`;const em=document.createElement('em');em.textContent=`${q.rate}%`;div.append(s,em);$('hard-items').append(div);}if(!r.items.length)msg('hard-items','아직 결과가 없습니다.');else if(!r.items.some(q=>q.rate<100))msg('hard-items','모든 출제 문항이 정답률 100%입니다.');
 tableRows('recent-table',r.students.slice(0,30),[a=>fmtDate(a.submittedAt),'name',a=>`${a.score} / ${a.maxScore}` ,a=>`${a.correct} / ${a.count}`,a=>`${a.rate}%`]);
 tableRows('item-table',r.items,['label','unit','exposures',a=>`${a.rate}%`,'analyzedDifficulty',a=>a.discrimination??a.discriminationStatus,a=>a.gap===null?'—':`${a.gap}%p`]);
 tableRows('choice-table',r.choices,['versionLabel','option',a=>a.isCorrect?'정답':'오답','count',a=>`${a.rate}%`]);
 renderStudentResultRows(r.students);}

function renderStudentResultRows(students){
 const tb=$('student-table');tb.replaceChildren();
 if(!students.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=9;td.textContent='해당 조건의 응시가 없습니다.';tr.append(td);tb.append(tr);return;}
 for(const a of students){const tr=document.createElement('tr');
  for(const value of [`${a.academicYear} · ${a.studentCode} ${a.name}`,fmtDate(a.submittedAt),a.score,a.maxScore,`${a.rate}%`,`${a.correct}/${a.count}`,a.level])textCell(tr,value);
  const download=document.createElement('button');download.type='button';download.className='secondary-button';download.textContent='개인 CSV';download.onclick=()=>downloadStudentCsv(a.id);
  const td=document.createElement('td');td.append(download);tr.append(td);
  const mark=document.createElement('button');mark.type='button';mark.className='secondary-button';mark.textContent=a.isTest?'테스트 해제':'테스트 지정';mark.onclick=()=>markTest(a.id,!a.isTest);
  const marker=document.createElement('td');marker.append(mark);tr.append(marker);tb.append(tr);
 }
}
async function markTest(id,isTest){
 if(connected){try{await api('admin-set-test',{id,isTest},state.token);}catch(err){toast('테스트 표시 오류: '+err.message);return;}}
 const item=state.attempts.find(a=>a.id===id);if(item)item.isTest=isTest;
 updateReport();toast(isTest?'테스트 기록으로 표시했습니다.':'테스트 표시를 해제했습니다.');
}
async function deleteTestRecords(){
 const count=state.attempts.filter(a=>a.isTest).length;
 if(!count){toast('테스트 표시된 기록이 없습니다.');return;}
 const value=prompt(`테스트 표시된 응시 ${count}건을 영구 삭제합니다. 삭제하려면 DELETE_TEST를 입력하세요.`);
 if(value!=='DELETE_TEST')return;
 try{
  if(connected)await api('admin-delete-tests',{confirm:'DELETE_TEST'},state.token);
  state.attempts=state.attempts.filter(a=>!a.isTest);populateReportFilters();updateReport();toast('테스트 응시 기록을 삭제했습니다.');
 }catch(err){toast('삭제 실패: '+err.message);}
}
function exportWorkbook(){
 if(!window.XLSX){toast('Excel 내보내기 도구가 준비되지 않았습니다. CSV를 사용하세요.');return;}
 const r=state.report;if(!r)return;
 const wb=window.XLSX.utils.book_new();
 for(const [title,rows] of [['학생별결과',r.students],['문항분석',r.items],['오답선택',r.choices],['단원분석',r.units],['상세응답',r.responses]]){
  const data=rows.length?rows:[{'안내':'해당하는 데이터가 없습니다.'}];
  const ws=window.XLSX.utils.json_to_sheet(data);window.XLSX.utils.book_append_sheet(wb,ws,title);
 }
 window.XLSX.writeFile(wb,'과학퀴즈_통합분석.xlsx');
}

function reportExport(which){const r=state.report;if(!r)return;switch(which){case 'scores':saveCSV(r.students.map(a=>({'학생':a.name,'학번':a.studentCode,'학년도':a.academicYear,'제출시각':a.submittedAt,'점수':a.score,'만점':a.maxScore,'백분율':a.rate,'정답수':a.correct,'문항수':a.count,'성취수준':a.level})),'학생별성적.csv');break;case 'items':saveCSV(r.items,'문항분석.csv');break;case 'choices':saveCSV(r.choices,'오답선택분석.csv');break;case 'responses':saveCSV(r.responses.map(a=>({'학생':a.studentName,'학번':a.studentCode,'제출시각':a.submittedAt,'문항ID':a.questionId,'문항버전':a.version,'단원':a.unit,'난이도':a.difficulty,'문제':a.prompt,'학생답':a.selectedText,'정답':a.correctText,'정오':a.isCorrect?'O':'X','획득점수':a.earned,'배점':a.points,'해설':a.explanation})),'전체상세응답.csv');break;}}
function fromSpreadsheetRow(row){const g=k=>row[k]??'';const choices=[1,2,3,4,5].map(i=>String(g(`선택지${i}`)).trim()).filter(Boolean);return {id:String(g('문항ID')).trim(),unit:String(g('단원')).trim(),difficulty:String(g('난이도')).trim(),prompt:String(g('문제')).trim(),choices,correctIndex:Number(g('정답번호'))-1,explanation:String(g('해설')).trim(),points:Number(g('배점'))};}
function csvToRows(csv){const rows=[];let cells=[],value='',quoted=false;for(let i=0;i<csv.length;i++){const c=csv[i];if(c==='"'){if(quoted&&csv[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){cells.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&csv[i+1]==='\n')i++;cells.push(value);value='';if(cells.some(v=>v.trim()))rows.push(cells);cells=[];}else value+=c;}cells.push(value);if(cells.some(v=>v.trim()))rows.push(cells);const headers=rows.shift().map(v=>v.replace(/^\ufeff/,'').trim());return rows.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]??''])));}
async function readQuestionFile(file){if(!file)throw new Error('엑셀 또는 CSV 파일을 선택하세요.');let rows;
 if(file.name.toLowerCase().endsWith('.csv'))rows=csvToRows(await file.text());
 else {if(!window.XLSX)throw new Error('엑셀 읽기 도구가 로드되지 않았습니다. 네트워크를 확인하거나 CSV를 사용하세요.');const wb=window.XLSX.read(await file.arrayBuffer(),{type:'array'});const name=wb.SheetNames.includes('문제은행')?'문제은행':wb.SheetNames[0];rows=window.XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:''});}
 const mapped=rows.map(fromSpreadsheetRow).filter(q=>q.id);if(!mapped.length)throw new Error('문항이 없습니다.');if(mapped.length>500)throw new Error('한 번에 500개 문항까지만 업로드할 수 있습니다.');return mapped;}
async function importBank(){msg('bank-feedback','');show('bank-feedback',false);$('import-button').disabled=true;try{const data=await readQuestionFile($('bank-file').files[0]);let total;if(connected){const result=await api('admin-import',{questions:data},state.token);total=result.count;}else{const map=new Map(state.demoQuestions.map(q=>[q.id,q]));for(const q of data)map.set(q.id,q);state.demoQuestions=[...map.values()];populateUnits([...new Set(state.demoQuestions.map(q=>q.unit))]);total=data.length;}
 msg('bank-feedback',`✓ ${total}문항을 등록·갱신했습니다.${!connected?' (이 브라우저의 데모에만 반영됩니다.)':''}`);show('bank-feedback');toast('문제은행 등록 완료');await loadBank();await refreshCatalog();}catch(err){msg('bank-feedback',`업로드 실패: ${err.message}`);show('bank-feedback');}finally{$('import-button').disabled=false;}}
async function loadBank(){try{state.bank=connected?(await api('admin-bank',null,state.token)).questions:state.demoQuestions.map(q=>({...q,active:true}));renderBank();}catch(err){msg('admin-error',err.message);}}
function renderBank(){const tb=$('bank-table');tb.replaceChildren();for(const q of state.bank){const tr=document.createElement('tr');for(const v of [q.id,q.unit,q.difficulty,q.prompt,q.points,q.active?'사용':'중지'])textCell(tr,v);const td=document.createElement('td');const btn=document.createElement('button');btn.type='button';btn.textContent=q.active?'사용 중지':'다시 사용';btn.onclick=()=>toggleBank(q);td.append(btn);tr.append(td);tb.append(tr);}if(!state.bank.length){tableRows('bank-table',[],['a','b','c','d','e','f','g']);}}
async function toggleBank(q){try{if(connected)await api('admin-status',{id:q.id,active:!q.active},state.token);else {const raw=byId(q.id);if(raw)raw.active=!q.active;}q.active=!q.active;renderBank();await refreshCatalog();toast(`문항 ${q.id}: ${q.active?'사용':'중지'}`);}catch(err){toast(err.message);}}
function exportBank(){saveCSV(state.bank.map(q=>({'문항ID':q.id,'단원':q.unit,'난이도':q.difficulty,'문제':q.prompt,'선택지1':q.choices?.[0]||'','선택지2':q.choices?.[1]||'','선택지3':q.choices?.[2]||'','선택지4':q.choices?.[3]||'','선택지5':q.choices?.[4]||'','정답번호':Number(q.correctIndex)+1,'해설':q.explanation,'배점':q.points,'사용여부':q.active?'사용':'중지'})),'과학퀴즈_문제은행.csv');}
async function logout(){if(connected&&supabase)await supabase.auth.signOut();state.token=null;state.report=null;state.attempts=[];state.bank=[];for(const id of ['student-table','recent-table','bank-table','item-table','choice-table'])$(id).replaceChildren();show('admin-workspace',false);show('teacher-login');msg('teacher-password','');}
function bindEvents(){
 $('resume-quiz').onclick=resumeQuiz;$('discard-quiz').onclick=clearProgress;
 for(const id of ['unit-select','difficulty-select','quiz-mode','count-select'])$(id).addEventListener('change',updateAvailableCount);
 for(const id of ['filter-year','filter-unit','include-test'])$(id).addEventListener('change',updateReport);$('filter-student').addEventListener('input',updateReport);
 $('delete-test-records').onclick=deleteTestRecords;$('export-workbook').onclick=exportWorkbook;
 $('nav-student').onclick=()=>navigate('student');$('nav-teacher').onclick=()=>navigate('teacher');$('quiz-form').onsubmit=beginQuiz;$('next-button').onclick=nextQuestion;$('download-result').onclick=downloadPersonal;$('retry-button').onclick=retry;
 $('login-form').onsubmit=loginTeacher;$('demo-login').onclick=()=>{loadAdmin().then(()=>toast('샘플 데이터 관리자 체험입니다.'));};$('logout-button').onclick=logout;$('refresh-report').onclick=loadAdmin;
 $('attempt-policy').onchange=()=>{updateReport();};
 for(const b of document.querySelectorAll('[data-admin-tab]'))b.onclick=()=>{tabSwitch(b.dataset.adminTab);if(b.dataset.adminTab==='bank')loadBank();};
 $('export-scores').onclick=()=>reportExport('scores');$('export-items').onclick=()=>reportExport('items');$('export-choices').onclick=()=>reportExport('choices');$('export-responses').onclick=()=>reportExport('responses');
 $('import-button').onclick=importBank;$('load-bank').onclick=loadBank;$('export-bank').onclick=exportBank;
}
init();
