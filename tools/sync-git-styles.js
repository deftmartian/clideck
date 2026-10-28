// Embed only the shared theme and diff rules. An opaque plugin frame must not
// depend on a second stylesheet request succeeding through an authenticated proxy.
const {readFileSync,writeFileSync}=require('node:fs');
const {resolve}=require('node:path');
function syncGitStyles({check=false}={}) {
  const css=readFileSync(resolve(__dirname,'../public/css/app.css'),'utf8');
  const required=pattern=>{const match=css.match(pattern);if(!match)throw Error('Shared Git style source changed; update the style extractor.');return match[0];};
  const rules=[
    required(/^:root \{[\s\S]*?^\}/m),
    required(/^:root\[data-theme="light"\] \{[\s\S]*?^\}/m),
    required(/^\* \{[^}]+\}/m),
    required(/^body \{[^}]+\}/m),
    required(/\/\* diff \*\/[\s\S]*?(?=\/\* chart \*\/)/),
  ].join('\n');
  const path=resolve(__dirname,'../plugins/git-diff/public/index.html');
  const html=readFileSync(path,'utf8');
  const marker=/<!-- BEGIN SHARED GIT STYLES -->[\s\S]*?<!-- END SHARED GIT STYLES -->/;
  if(!marker.test(html))throw Error('Git style markers missing.');
  const next=html.replace(marker,`<!-- BEGIN SHARED GIT STYLES -->\n<!-- Generated from public/css/app.css by tools/sync-git-styles.js. -->\n<style>\n${rules}\n</style>\n<!-- END SHARED GIT STYLES -->`);
  if(next===html)return;
  if(check)throw Error('Git styles are stale. Run node tools/sync-git-styles.js.');
  writeFileSync(path,next);
}
if(require.main===module)syncGitStyles({check:process.argv.includes('--check')});
module.exports={syncGitStyles};
