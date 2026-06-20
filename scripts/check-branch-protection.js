import https from 'https';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.log('GITHUB_TOKEN not set. Skipping branch protection check.');
  process.exit(0);
}

const REPOS = [
  'shunhang776/xinbaijin',
  'shunhang776/xinbaijin-mcp'
];

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'check-branch-protection',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

async function main() {
  let allPassed = true;

  for (const repo of REPOS) {
    console.log(`${repo}:dev`);

    let status, body;
    try {
      ({ status, body } = await apiRequest(`/repos/${repo}/branches/dev/protection`));
    } catch (err) {
      console.log(`  ERROR: Request failed — ${err.message}`);
      allPassed = false;
      continue;
    }

    if (status === 404) {
      console.log('  force-push disabled: WARN (branch protection not configured)');
      console.log('  deletion disabled:    WARN (branch protection not configured)');
      continue;
    }

    if (status !== 200) {
      console.log(`  ERROR: Unexpected HTTP status ${status}`);
      allPassed = false;
      continue;
    }

    let protection;
    try {
      protection = JSON.parse(body);
    } catch (e) {
      console.log(`  ERROR: Failed to parse response — ${e.message}`);
      allPassed = false;
      continue;
    }

    // Check allow_force_pushes
    const fpe = protection.allow_force_pushes;
    if (fpe && fpe.enabled === false) {
      console.log('  force-push disabled: PASS');
    } else if (fpe && fpe.enabled === true) {
      console.log('  force-push disabled: FAIL (currently enabled)');
      allPassed = false;
    } else {
      console.log('  force-push disabled: WARN (unexpected or missing value)');
    }

    // Check allow_deletions
    const ad = protection.allow_deletions;
    if (ad && ad.enabled === false) {
      console.log('  deletion disabled:    PASS');
    } else if (ad && ad.enabled === true) {
      console.log('  deletion disabled:    FAIL (currently enabled)');
      allPassed = false;
    } else {
      console.log('  deletion disabled:    WARN (unexpected or missing value)');
    }
  }

  if (allPassed) {
    console.log('\nAll checks passed.');
    process.exit(0);
  } else {
    console.log('\nSome checks failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
