const { execSync } = require('child_process');
const pkg = require('../package.json');

const tag = `v${pkg.version}`;
console.log(`\n🚀 Preparing release for ${tag}...`);

try {
  // Commit package.json if modified
  execSync(`git add package.json && git commit -m "chore: release ${tag}"`, { stdio: 'inherit' });
} catch {
  // Nothing to commit or already committed
}

try {
  // Create tag
  console.log(`📌 Creating tag ${tag}...`);
  execSync(`git tag ${tag}`, { stdio: 'inherit' });
} catch (err) {
  console.log(`⚠️ Tag ${tag} already exists locally. Attempting to push...`);
}

// Push commit and tag
console.log(`⬆️ Pushing commits and tag ${tag} to GitHub...`);
execSync('git push', { stdio: 'inherit' });
execSync(`git push origin ${tag}`, { stdio: 'inherit' });

console.log(`\n✅ Done! Release workflow for ${tag} is now triggered on GitHub Actions!`);
console.log(`👉 Track build progress at: https://github.com/mamirhamzadev/orderx-print-agent/actions\n`);
