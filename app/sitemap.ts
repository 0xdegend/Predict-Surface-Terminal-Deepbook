import type { MetadataRoute } from 'next';
import { siteConfig, siteUrl } from '@/config/site';

// Served at /sitemap.xml. Lists the public routes (the dynamic /trader/* pages
// are excluded — they're per-address and not worth indexing).
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return siteConfig.routes.map((path) => ({
    url: `${siteUrl}${path}`,
    lastModified: now,
    changeFrequency: path === '' ? 'hourly' : 'daily',
    priority: path === '' ? 1 : 0.7,
  }));
}
