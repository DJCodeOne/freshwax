import Stripe from 'stripe';

const STRIPE_API_VERSION = '2024-12-18.acacia' as const;

export function createStripeClient(env: Record<string, unknown>): Stripe | null {
  const secretKey = (env?.STRIPE_SECRET_KEY || import.meta.env.STRIPE_SECRET_KEY) as string | undefined;
  if (!secretKey) return null;
  return new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
}
