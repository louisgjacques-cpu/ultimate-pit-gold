const fs = require('fs');
let html = fs.readFileSync('template.html', 'utf8');
for (const [tag, file] of [['/*__CORE__*/', 'core.js'], ['/*__SCENE__*/', 'scene.js'], ['/*__UI__*/', 'ui.js']]) {
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('</script')) throw new Error('script close tag inside ' + file);
  html = html.replace(tag, () => src);
}
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log('built dist/index.html', (html.length / 1024).toFixed(1) + ' KB');
