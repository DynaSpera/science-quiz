import { createClient } from 'npm:@supabase/supabase-js@2';

const projectUrl = Deno.env.get('SUPABASE_URL') || '';
const secretKeys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secretKeys.default || '';
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
const classroomCode = Deno.env.get('QUIZ_ACCESS_CODE') || '';
const admin = createClient(projectUrl, serviceKey, {auth:{persistSession:false,autoRefreshToken:false}});
const respond = (body:unknown, status=200, origin='') => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json; charset=utf-8',...corsHeaders(origin)}});
const corsHeaders = (origin:string) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Vary': 'Origin',
  'Cache-Control': 'no-store',
});
const errorText = (error:unknown) => error instanceof Error?error.message:String(error);
const text = (v:unknown, max:number) => typeof v==='string'?v.trim().slice(0,max):'';
const randomize = <T>(items:T[]):T[] => {
 const a=[...items];
 for(let i=a.length-1;i>0;i--){const buf=new Uint32Array(1);crypto.getRandomValues(buf);const j=buf[0]%(i+1);[a[i],a[j]]=[a[j],a[i]];}
 return a;
};
const isUUID = (v:unknown) => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const validUnit = (v:unknown)=>v==='all'||typeof v==='string'&&v.length<=60;

async function requireTeacher(req:Request) {
 const header=req.headers.get('authorization')||'';
 const match=/^Bearer\s+(\S+)$/i.exec(header);
 if(!match)throw new Error('교사 로그인이 필요합니다.');
 const {data,error}=await admin.auth.getUser(match[1]);
 if(error||!data.user||data.user.is_anonymous)throw new Error('유효하지 않은 로그인입니다.');
 const {data:teacher,error:dbError}=await admin.from('teacher_accounts').select('user_id').eq('user_id',data.user.id).maybeSingle();
 if(dbError||!teacher)throw new Error('관리자 접근 권한이 없습니다.');
 return data.user;
}
async function loadActiveQuestions(){
 const out:any[]=[];
 for(let from=0;from<5000;from+=1000){
   const {data,error}=await admin.from('questions').select('id,unit,difficulty,prompt,choices,correct_index,explanation,points').eq('active',true).order('id').range(from,from+999);
   if(error)throw new Error('문제은행을 읽을 수 없습니다.');
   out.push(...(data||[]));if((data||[]).length<1000)break;
 }
 return out;
}
async function handle(action:string,req:Request):Promise<unknown>{
 if(action==='catalog' && req.method==='GET'){
   const qs=await loadActiveQuestions();
   return {units:[...new Set(qs.map(q=>q.unit))].sort(),total:qs.length};
 }
 if(action==='start' && req.method==='POST'){
   const body=await req.json();const studentName=text(body.studentName,40),studentCode=text(body.studentCode,24),count=Number(body.count);
   const unit=body.unit??'all',difficulty=body.difficulty??'all';
   if(!studentName)throw new Error('이름 또는 별칭을 입력하세요.');
   if(!Number.isInteger(count)||count<1||count>30)throw new Error('문항 수는 1~30이어야 합니다.');
   if(!validUnit(unit)||!['all','쉬움','보통','어려움'].includes(difficulty))throw new Error('출제 조건이 올바르지 않습니다.');
   if(!classroomCode)throw new Error('교사가 서버에 수업 참여 코드를 먼저 설정해야 합니다.');
   if(body.accessCode!==classroomCode)throw new Error('수업 참여 코드가 일치하지 않습니다.');
   const bank=await loadActiveQuestions();
   const selected=randomize(bank.filter(q=>(unit==='all'||q.unit===unit)&&(difficulty==='all'||q.difficulty===difficulty))).slice(0,count);
   if(!selected.length)throw new Error('해당 조건에 맞는 문제가 없습니다.');
   const quizItems=selected.map(q=>{
     const shuffled=randomize((q.choices as string[]).map((choice:string,index:number)=>({choice,index})));
     return {id:q.id,unit:q.unit,difficulty:q.difficulty,prompt:q.prompt,
       options:shuffled.map(x=>x.choice),correctIndex:shuffled.findIndex(x=>x.index===q.correct_index),
       explanation:q.explanation,points:q.points};
   });
   const {data,error}=await admin.from('attempts').insert({student_name:studentName,student_code:studentCode,quiz_items:quizItems,status:'started'}).select('id').single();
   if(error||!data)throw new Error('퀴즈를 시작할 수 없습니다.');
   return {attemptId:data.id,questions:quizItems.map(({correctIndex:_c,explanation:_e,...publicQuestion})=>publicQuestion)};
 }
 if(action==='submit' && req.method==='POST'){
   const body=await req.json();if(!isUUID(body.attemptId))throw new Error('응시ID 형식이 올바르지 않습니다.');
   const {data:attempt,error}=await admin.from('attempts').select('id,student_name,student_code,status,quiz_items').eq('id',body.attemptId).maybeSingle();
   if(error||!attempt)throw new Error('응시 기록을 찾지 못했습니다.');
   if(attempt.status!=='started')throw new Error('이미 제출된 퀴즈입니다.');
   const answers=body.answers;
   if(!answers||typeof answers!=='object'||Array.isArray(answers))throw new Error('답안 형식이 올바르지 않습니다.');
   const quizItems=attempt.quiz_items as any[];
   if(quizItems.length>30||quizItems.length<1)throw new Error('출제 데이터가 올바르지 않습니다.');
   const items=quizItems.map(q=>{
     const selectedIndex=answers[q.id];
     if(!Number.isInteger(selectedIndex)||selectedIndex<0||selectedIndex>=q.options.length)throw new Error('모든 문항에 답해야 제출할 수 있습니다.');
     const isCorrect=selectedIndex===q.correctIndex;
     return {questionId:q.id,unit:q.unit,difficulty:q.difficulty,prompt:q.prompt,selectedIndex,
       selectedText:q.options[selectedIndex],correctIndex:q.correctIndex,correctText:q.options[q.correctIndex],
       isCorrect,earned:isCorrect?q.points:0,points:q.points,explanation:q.explanation};
   });
   const score=items.reduce((sum,item)=>sum+item.earned,0),maxScore=items.reduce((sum,item)=>sum+item.points,0);
   const submittedAt=new Date().toISOString();
   const {data:updated,error:saveError}=await admin.from('attempts').update({result_items:items,score,max_score:maxScore,status:'submitted',submitted_at:submittedAt}).eq('id',attempt.id).eq('status','started').select('id').maybeSingle();
   if(saveError||!updated)throw new Error('제출이 중복되었거나 저장에 실패했습니다.');
   return {id:attempt.id,status:'submitted',score,maxScore,resultItems:items,submittedAt};
 }
 // 나머지 엔드포인트는 반드시 교사 인증 및 teacher_accounts 조회 후에 실행.
 await requireTeacher(req);
 if(action==='admin-report' && req.method==='GET'){
   const attempts:any[]=[];
   for(let from=0;from<10000;from+=500){
     const {data,error}=await admin.from('attempts').select('id,student_name,student_code,score,max_score,submitted_at,result_items,status').eq('status','submitted').order('submitted_at',{ascending:false}).range(from,from+499);
     if(error)throw new Error('응시 결과를 불러오지 못했습니다.');
     attempts.push(...(data||[]));if((data||[]).length<500)break;
   }
   return {attempts:attempts.map(a=>({id:a.id,studentName:a.student_name,studentCode:a.student_code,score:Number(a.score),maxScore:Number(a.max_score),submittedAt:a.submitted_at,resultItems:a.result_items,status:a.status}))};
 }
 if(action==='admin-bank' && req.method==='GET'){
   const data:any[]=[];
   for(let from=0;from<5000;from+=1000){
     const result=await admin.from('questions').select('*').order('id').range(from,from+999);
     if(result.error)throw new Error('문항 목록을 읽지 못했습니다.');
     data.push(...(result.data||[]));if((result.data||[]).length<1000)break;
   }
   return {questions:data.map(q=>({id:q.id,unit:q.unit,difficulty:q.difficulty,prompt:q.prompt,choices:q.choices,correctIndex:q.correct_index,explanation:q.explanation,points:q.points,active:q.active}))};
 }
 if(action==='admin-import' && req.method==='POST'){
   const body=await req.json();const input=body.questions;
   if(!Array.isArray(input)||!input.length||input.length>500)throw new Error('한 번에 1~500문항을 등록할 수 있습니다.');
   const seen=new Set<string>();
   const rows=input.map(q=>{
     const id=text(q.id,50),unit=text(q.unit,60),difficulty=text(q.difficulty,10),prompt=text(q.prompt,1000),explanation=text(q.explanation,3000);
     const choices=Array.isArray(q.choices)?q.choices.map((c:unknown)=>text(c,500)):[];
     const correctIndex=Number(q.correctIndex),points=Number(q.points);
     if(!id||seen.has(id)||!unit||!prompt||!['쉬움','보통','어려움'].includes(difficulty)||choices.length<4||choices.length>5||choices.some((c:string)=>!c)||!Number.isInteger(correctIndex)||correctIndex<0||correctIndex>=choices.length||!Number.isInteger(points)||points<1||points>100)throw new Error(`문항 형식 또는 중복 ID 오류: ${id||'(ID 없음)'}`);
     seen.add(id);
     return {id,unit,difficulty,prompt,choices,correct_index:correctIndex,explanation,points,active:true,updated_at:new Date().toISOString()};
   });
   const {error}=await admin.from('questions').upsert(rows,{onConflict:'id'});
   if(error)throw new Error(`문항 등록 오류: ${error.message}`);
   return {count:rows.length};
 }
 if(action==='admin-status' && req.method==='POST'){
   const body=await req.json(),id=text(body.id,50);
   if(!id||typeof body.active!=='boolean')throw new Error('문항 변경 요청이 올바르지 않습니다.');
   const {data,error}=await admin.from('questions').update({active:body.active,updated_at:new Date().toISOString()}).eq('id',id).select('id').maybeSingle();
   if(error||!data)throw new Error('문항 상태를 변경할 수 없습니다.');
   return {ok:true};
 }
 throw new Error('알 수 없는 API 요청입니다.');
}

Deno.serve(async (req:Request)=>{
 const origin=req.headers.get('origin')||'';
 // CORS는 브라우저 차단 장치이며 별도의 인증/접근 코드가 보안 경계입니다.
 const allowed=Boolean(origin&&allowedOrigins.includes(origin));
 if(!allowed)return respond({error:'허용되지 않은 사이트 출처입니다. ALLOWED_ORIGINS 설정을 확인하세요.'},403,'null');
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:corsHeaders(origin)});
 if(!projectUrl||!serviceKey)return respond({error:'Supabase 환경 변수가 설정되지 않았습니다.'},500,origin);
 const action=new URL(req.url).pathname.split('/').pop()||'';
 try{return respond(await handle(action,req),200,origin);}
 catch(err){
   const message=errorText(err);
   const isAuth=/로그인|권한|유효하지 않은/.test(message);
   const isServer=/읽지 못|저장에 실패|등록 오류/.test(message);
   return respond({error:isServer?'서버 저장 또는 조회에 실패했습니다. 관리자에게 문의하세요.':message},isAuth?403:isServer?500:400,origin);
 }
});
