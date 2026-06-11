import type { MetadataRoute } from 'next';
import { siteUrl } from '@/config/site';

// Served at /robots.txt. Allows all crawlers and points them at the sitemap.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/' },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
