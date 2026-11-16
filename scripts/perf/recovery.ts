import vm from 'node:vm';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const repo=fileURLToPath(new URL('../../', import.meta.url));
if (!process.env.NATIVE_MODULE_DIR || !process.env.RECOVERY_READY) throw new Error('NATIVE_MODULE_DIR and RECOVERY_READY are required');
const {ShmGraphicBuffer}=createRequire(import.meta.url)(process.env.NATIVE_MODULE_DIR);
const {createTerminalOutput}=await import(repo+'/src/tty/output.ts');
const {createTerminalGraphics}=await import(repo+'/src/tty/kittyGraphics.ts');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data',()=>{});
const retained:any[]=[];
const output=createTerminalOutput(s=>process.stdout.write(s));
const graphics=createTerminalGraphics(output,(_id,b)=>retained.push(b));
const init=new ShmGraphicBuffer(320*240*4);init.write(Buffer.alloc(320*240*4),320);
const container=graphics.paintInitialFrame(init,{width:320,height:240});
const loads: Array<{width:number;height:number;offset:unknown}> = [];
const load = container.loadFrame.bind(container);
container.loadFrame = ((frame:any, buffer:any, size:any, offset:any) => {
  loads.push({...size,offset});
  return load(frame,buffer,size,offset);
}) as typeof container.loadFrame;
function fullRecovery(width:number,height:number) {
  const last=loads.at(-1);
  if (!last || last.width!==width || last.height!==height || last.offset) throw new Error('Recovery did not submit a full page frame');
}
let paint:any;let allowed=true;
const window={webContents:{on(_e:string,f:any){paint=f},off(){}}};
const terminal={output,settings:{},features:{},identity:{},canPaint:()=>allowed};
const source=readFileSync(process.env.PAINT_SOURCE ?? repo+'/src/paint.ts','utf8');
if (!source.includes('const weakPaintedContents_')) throw new Error('paint.ts extraction marker missing');
const js=new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(source.indexOf('const weakPaintedContents_')).replaceAll('export function','function'));
const context=vm.createContext({Buffer,Uint8Array,ShmGraphicBuffer,window,terminal,container,layout:{deviceLayout:{x:0,y:0,width:320,height:240}},options:{},features:{current:{}},frameTrace:{enabled:false,now:()=>0,record(){},skip(){}},rememberTabThumbnail(){},Mode:{pendingUpdate:2026},getWindowSize:()=>({width:320,height:240}),console_:console});
vm.runInContext(js,context);
const painted=vm.runInContext('registerPaintedContent(container,window,layout,terminal)',context);
const pause=()=>new Promise(r=>setTimeout(r,250));
async function checkpoint(name:string) {
  await pause();
  const marker=process.env.RECOVERY_READY! + '.' + name;
  writeFileSync(marker, 'ready');
  const deadline=Date.now()+15000;
  while (!existsSync(marker+'.captured') && Date.now()<deadline) await new Promise(r=>setTimeout(r,25));
  if (!existsSync(marker+'.captured')) throw new Error('Capture timed out: '+name);
}
function image(width:number,height:number,red=false, left=45){const pixels=Buffer.alloc(width*height*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=40;pixels[i+1]=90;pixels[i+2]=20;pixels[i+3]=255;}if(red)for(let y=30;y<50;y++)for(let x=left;x<left+20;x++){const i=(y*width+x)*4;pixels[i]=30;pixels[i+1]=40;pixels[i+2]=240;}return {getSize:()=>({width,height}),getScaleFactors:()=>[1],toBitmap:()=>pixels};}
const full={x:0,y:0,width:320,height:240}, dirty={x:45,y:30,width:20,height:20};
await paint({},full,image(320,240));await pause();
await paint({},dirty,image(320,240,true));await checkpoint('partial');
painted.cover(true);await checkpoint('cover');
allowed=false;painted.cover(false);await paint({},dirty,image(320,240));allowed=true;
await paint({},dirty,image(320,240,true));fullRecovery(320,240);await checkpoint('uncover');
// Suppressed paint and bitmap resize both require a full recovery transfer.
(window as any).isSuppressingPaint=true;await paint({},dirty,image(320,240));(window as any).isSuppressingPaint=false;
await paint({},dirty,image(320,240,true));fullRecovery(320,240);await checkpoint('suppression');
await paint({},dirty,image(300,220,true));fullRecovery(300,220);await checkpoint('shrink');
await paint({},dirty,image(300,220,true));await pause();
// Dirty bounds cover both the old and new block positions, including erased pixels.
let previousLeft=45;
for (const [index,left] of [75,105,135,105,75,45].entries()) {
  const movingDirty={x:Math.min(previousLeft,left),y:30,width:Math.abs(left-previousLeft)+20,height:20};
  await paint({},movingDirty,image(300,220,true,left));
  await checkpoint('motion-'+index);
  previousLeft=left;
}
writeFileSync(process.env.RECOVERY_READY!, 'ready');
// The runner resizes the real X11 terminal, then requests a retained-frame refresh.
const resized = process.env.RECOVERY_READY! + '.resized';
const deadline = Date.now() + 15000;
while (!existsSync(resized) && Date.now() < deadline) await new Promise(r=>setTimeout(r,50));
if (!existsSync(resized)) throw new Error('Timed out waiting for terminal resize');
context.layout.deviceLayout.width = 360;
context.layout.deviceLayout.height = 260;
painted.refresh();
await paint({},dirty,image(360,260,true));
fullRecovery(360,260);
await pause();
writeFileSync(process.env.RECOVERY_READY! + '.refreshed', 'ready');
await new Promise(r=>setTimeout(r,15000));
