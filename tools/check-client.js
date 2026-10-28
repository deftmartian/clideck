const {buildClient}=require('./build-client');
const {mkdtempSync,readFileSync,readdirSync,rmSync}=require('fs');
const {join,relative,resolve}=require('path');
const {tmpdir}=require('os');
const {createHash}=require('crypto');
function inventory(root,dir=root,out={}) {for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())inventory(root,path,out);else out[relative(root,path)]=createHash('sha256').update(readFileSync(path)).digest('hex');}return out;}
(async()=>{
 const dir=mkdtempSync(join(tmpdir(),'clideck-client-check-'));
 try {
  await buildClient(join(dir,'one'));await buildClient(join(dir,'two'));
  const one=JSON.stringify(inventory(join(dir,'one')));
  if(one!==JSON.stringify(inventory(join(dir,'two'))))throw new Error('Client builds differ.');
  if(one!==JSON.stringify(inventory(resolve(__dirname,'../dist/public'))))throw new Error('Staged client is stale. Run npm run build:client.');
  console.log('PASS: two deterministic builds match the staged client');
 }finally{rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
