const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(projectRoot, 'package.json');
let pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Optional argument: patch | minor | major (e.g. npm run push:release patch)
const bumpType = process.argv[2];
if (bumpType && ['patch', 'minor', 'major'].includes(bumpType.toLowerCase())) {
  console.log(`\n🔢 Auto-bumping ${bumpType} version in package.json...`);
  execSync(`npm version ${bumpType.toLowerCase()} --no-git-tag-version`, { cwd: projectRoot, stdio: 'inherit' });
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
}

const tag = `v${pkg.version}`;
console.log(`\n🚀 Preparing release for ${tag}...`);

try {
  // Commit package.json if modified
  execSync(`git add package.json && git commit -m "chore: release ${tag}"`, { cwd: projectRoot, stdio: 'inherit' });
} catch {
  // Nothing to commit or already committed
}

try {
  // Create tag
  console.log(`📌 Creating tag ${tag}...`);
  execSync(`git tag ${tag}`, { cwd: projectRoot, stdio: 'inherit' });
} catch (err) {
  console.log(`⚠️ Tag ${tag} already exists locally. Attempting to push...`);
}

// Push commit and tag
console.log(`⬆️ Pushing commits and tag ${tag} to GitHub...`);
execSync('git push', { cwd: projectRoot, stdio: 'inherit' });
execSync(`git push origin ${tag}`, { cwd: projectRoot, stdio: 'inherit' });

console.log(`\n✅ Done! Release workflow for ${tag} is now triggered on GitHub Actions!`);
console.log(`👉 Track build progress at: https://github.com/mamirhamzadev/orderx-print-agent/actions\n`);
