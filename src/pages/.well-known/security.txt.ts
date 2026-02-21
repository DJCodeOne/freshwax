// src/pages/.well-known/security.txt.ts
// RFC 9116 security.txt — https://www.rfc-editor.org/rfc/rfc9116
import type { APIRoute } from 'astro';
import { SITE_URL } from '../../lib/constants';

export const prerender = false;

/** Build an ISO 8601 expiry date ~1 year from now */
function getExpiry(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString();
}

export const GET: APIRoute = () => {
  const body = `Contact: mailto:security@freshwax.co.uk
Expires: ${getExpiry()}
Preferred-Languages: en
Canonical: ${SITE_URL}/.well-known/security.txt
`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
    },
  });
};
