const { build } = require('esbuild');
const { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } = require('fs');
const { resolve, join, extname, dirname } = require('path');
const { gzipSync, brotliCompressSync, constants } = require('zlib');

async function buildClient(output = resolve(__dirname, '../dist/public')) {
  require('./sync-git-styles').syncGitStyles({check:true});
  rmSync(output, { recursive:true, force:true }); mkdirSync(output,{recursive:true});
  cpSync(resolve(__dirname, '../public'),output,{recursive:true});
  mkdirSync(join(output,'vendor'),{recursive:true});
  const xterm = require.resolve('@xterm/xterm');
  for (const [name,source] of [
    ['xterm.js',xterm],['xterm.css',resolve(dirname(xterm),'../css/xterm.css')],
    ['xterm-webgl.js',require.resolve('@xterm/addon-webgl')],
    ['mermaid.js',resolve(dirname(require.resolve('mermaid/package.json')),'dist/mermaid.min.js')],
  ]) cpSync(source,join(output,'vendor',name));
  const result = await build({
    stdin:{ contents:"import { Terminal } from '@xterm/xterm'; window.Terminal = Terminal; import('./public/js/app.js');", resolveDir:resolve(__dirname,'..'), sourcefile:'client-entry.js' },
    bundle:true, format:'esm', target:'es2020', minify:true, metafile:true,
    outdir:join(output,'build'), entryNames:'app-[hash]', write:true,
  });
  const script = Object.keys(result.metafile.outputs).find(path=>path.endsWith('.js'));
  let html=readFileSync(join(output,'index.html'),'utf8');
  html=html.replace('<script src="/vendor/xterm.js"></script>','').replace(/<script type="module" src="\/js\/app.js"><\/script>/,`<script type="module" src="/build/${script.split('/').at(-1)}"></script>`);
  writeFileSync(join(output,'index.html'),html);
  function compress(dir) {
    for(const file of readdirSync(dir,{withFileTypes:true})) {
      const path=join(dir,file.name);
      if(file.isDirectory()){compress(path);continue;}
      if(!['.js','.css','.html','.svg','.json','.webmanifest'].includes(extname(path)))continue;
      const bytes=readFileSync(path);
      writeFileSync(path+'.gz',gzipSync(bytes,{level:9}));
      writeFileSync(path+'.br',brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:9}}));
    }
  }
  compress(output);
  return {output,script};
}
if(require.main===module)buildClient().then(result=>console.log(`Built ${result.output}`)).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={buildClient};
