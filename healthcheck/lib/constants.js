'use strict';

// Central config so the checks and the CI workflow agree on one source of
// truth — change the live URL or local port here, not in five places.
module.exports = {
  LIVE_URL: 'https://appliedconceptsnl.github.io/app/',
  LOCAL_PORT: 8934, // matches dev-server.py's own default
  REPO_ROOT: require('path').resolve(__dirname, '..', '..'),
  ARTIFACTS_DIR: require('path').resolve(__dirname, '..', 'artifacts'),
  REPORT_PATH: require('path').resolve(__dirname, '..', 'report.json'),
  // Real page tabs, in the order they appear in the tabbar — kept here
  // instead of scraped, since the check needs this list even before the
  // page has loaded to know what to iterate over.
  TABS: ['optic', 'profiles', 'turret', 'dryfire', 'train', 'shottimer', 'dopecard', 'shop', 'contact'],
  VIEWPORTS: [
    { name: 'mobile', width: 375, height: 812 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1280, height: 900 },
  ],
  PAGE_DIMS_IN: {
    a4: { w: 8.2677, h: 11.6929 },
    letter: { w: 8.5, h: 11 },
  },
  // Realistic HOB range in inches (~1" to ~8") — generous enough to cover
  // everything from a low-mount red dot to a GBRS Hydra riser, tight enough
  // to still catch a typo'd value (e.g. HOB entered as cm forgetting the
  // unit, or a stray 0).
  HOB_REALISTIC_RANGE_IN: [1.0, 8.0],
};
