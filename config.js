/* Sync config — Cloudflare Worker public media (encrypted) */
window.VC_CONFIG = {
  githubOwner: 'simonvu',
  githubRepo: 'vibechic-mau-tin',
  branch: 'main',
  // Primary: Cloudflare Worker public endpoints
  syncBaseUrl: 'https://vibechic-admin.tusinh-information.workers.dev/public',
  templatesUrl: 'https://vibechic-admin.tusinh-information.workers.dev/public/templates.json',
  cryptoMetaUrl: 'https://vibechic-admin.tusinh-information.workers.dev/public/crypto-meta.json',
  mediaBaseUrl: 'https://vibechic-admin.tusinh-information.workers.dev/public/',
  // Fallback raw/GitHub Pages (legacy)
  templatesRawUrl: 'https://simonvu.github.io/vibechic-mau-tin/templates.json',
  cryptoMetaRawUrl: 'https://simonvu.github.io/vibechic-mau-tin/crypto-meta.json',
  pagesAppUrl: 'https://simonvu.github.io/vibechic-mau-tin/',
  pagesAdminUrl: 'https://vibechic-admin.tusinh-information.workers.dev/'
};
