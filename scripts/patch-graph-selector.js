/*
 * graph-selector@0.13.0 has a stateful global regex `featuresRe` whose
 * lastIndex carries across calls to `getFeatureData`. That causes node
 * IDs and classes on later lines to silently disappear (e.g. lines that
 * use `#id` after enough preceding lines reset to `n<lineNumber>`),
 * which in turn makes graph-selector drop any edges that reference those
 * IDs. We patch the bundled output to reset `lastIndex` at the start of
 * `getFeatureData`. Safe to run repeatedly.
 */
const fs = require('fs');
const path = require('path');

const targets = [
  path.join(__dirname, '..', 'node_modules', 'graph-selector', 'dist', 'graph-selector.cjs'),
  path.join(__dirname, '..', 'node_modules', 'graph-selector', 'dist', 'graph-selector.mjs'),
];

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (src.includes('featuresRe.lastIndex = 0;\n    if (!match.groups)')) {
    continue;
  }
  let patched = src;
  // Reset before the loop starts.
  if (!patched.includes('featuresRe.lastIndex = 0;\n  while')) {
    patched = patched.replace(
      /(  let attributes = "";\n)(  while \(\(match = featuresRe\.exec)/,
      '$1  featuresRe.lastIndex = 0;\n$2'
    );
  }
  // Reset on every iteration too, because `line` is mutated inside the loop
  // and lastIndex would otherwise point past the (now shifted) next match,
  // silently dropping ids/classes/attrs that appeared further along the line.
  patched = patched.replace(
    /(  while \(\(match = featuresRe\.exec\(line\)\) != null\) \{\n)(    if \(!match\.groups\) continue;)/,
    '$1    featuresRe.lastIndex = 0;\n$2'
  );
  if (patched === src) {
    console.error('patch-graph-selector: no match in', file);
    process.exit(1);
  }
  fs.writeFileSync(file, patched);
  console.log('patch-graph-selector: patched', path.basename(file));
}
