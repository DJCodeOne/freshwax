// src/pages/api/admin/giftcards.ts
// Admin API for gift cards management - list, create, analytics

import type { APIRoute } from 'astro';
import { z } from 'zod';
import { getDocument, updateDocument, setDocument, queryCollection, addDocument, arrayUnion } from '../../../lib/firebase-rest';
import { checkRateLimit, getClientId, rateLimitResponse, RateLimiters } from '../../../lib/rate-limit';
import { SITE_URL } from '../../../lib/constants';
import { fetchWithTimeout, ApiErrors } from '../../../lib/api-utils';
import { emailWrapper, ctaButton, esc } from '../../../lib/email-wrapper';

export const prerender = false;

const giftcardsPostSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('createCard'),
    value: z.number().positive(),
    type: z.string().optional(),
    description: z.string().optional(),
    expiresInDays: z.number().int().positive().optional(),
    adminKey: z.string().optional(),
  }),
  z.object({
    action: z.literal('adjustBalance'),
    userId: z.string().min(1),
    amount: z.union([z.number(), z.string()]),
    reason: z.string().optional(),
    adminKey: z.string().optional(),
  }),
  z.object({
    action: z.literal('deactivateCard'),
    cardId: z.string().min(1),
    adminKey: z.string().optional(),
  }),
  z.object({
    action: z.literal('reactivateCard'),
    cardId: z.string().min(1),
    adminKey: z.string().optional(),
  }),
  z.object({
    action: z.literal('resendEmail'),
    cardId: z.string().min(1),
    code: z.string().optional(),
    recipientEmail: z.string().email(),
    recipientName: z.string().optional(),
    adminKey: z.string().optional(),
  }),
]);

const FROM_EMAIL = 'Fresh Wax <noreply@freshwax.co.uk>';

// Helper to get admin key from environment
function getAdminKey(locals: App.Locals): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}



// Send email via Resend API (using fetch for Cloudflare compatibility)
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[admin/giftcards] No Resend API key configured');
    return false;
  }

  try {
    const response = await fetchWithTimeout('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to,
        subject,
        html
      }),
    }, 10000);

    if (!response.ok) {
      const error = await response.text();
      console.error('[admin/giftcards] Resend error:', response.status, error);
      return false;
    }

    return true;
  } catch (error: unknown) {
    console.error('[admin/giftcards] Email send error:', error);
    return false;
  }
}

// GET: Fetch gift cards, user balances, and analytics
export const GET: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`giftcards:${clientId}`, RateLimiters.admin);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);



  // SECURITY: Require admin authentication for viewing gift cards data
  const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
  const env = locals.runtime.env;
  initAdminEnv({
    ADMIN_UIDS: env?.ADMIN_UIDS || import.meta.env.ADMIN_UIDS,
    ADMIN_EMAILS: env?.ADMIN_EMAILS || import.meta.env.ADMIN_EMAILS,
  });

  const authError = await requireAdminAuth(request, locals);
  if (authError) {
    return authError;
  }

  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'all';

    if (type === 'analytics') {
      // Get analytics data with 5-min cache for dashboard (not real-time)
      const [giftCards, userCredits] = await Promise.all([
        queryCollection('giftCards', { cacheTime: 300000, limit: 1000 }),
        queryCollection('userCredits', { cacheTime: 300000, limit: 500 })
      ]);

      let totalIssued = 0;
      let totalRedeemed = 0;
      let totalUnredeemed = 0;
      let welcomeCardsIssued = 0;
      let promoCardsIssued = 0;

      giftCards.forEach(card => {
        totalIssued += card.originalValue || 0;

        if (card.redeemedBy) {
          totalRedeemed += card.originalValue || 0;
        } else if (card.isActive) {
          totalUnredeemed += card.currentBalance || 0;
        }

        if (card.type === 'welcome') welcomeCardsIssued++;
        if (card.type === 'promotional') promoCardsIssued++;
      });

      let totalCreditBalance = 0;
      let totalSpent = 0;
      let usersWithCredit = 0;

      userCredits.forEach(credit => {
        if (credit.balance > 0) {
          totalCreditBalance += credit.balance;
          usersWithCredit++;
        }

        // Calculate total spent from transactions
        if (credit.transactions) {
          credit.transactions.forEach((txn: any) => {
            if (txn.type === 'purchase' && txn.amount < 0) {
              totalSpent += Math.abs(txn.amount);
            }
          });
        }
      });

      return new Response(JSON.stringify({
        success: true,
        analytics: {
          giftCards: {
            totalCards: giftCards.length,
            totalValueIssued: totalIssued,
            totalValueRedeemed: totalRedeemed,
            totalValueUnredeemed: totalUnredeemed,
            welcomeCardsIssued,
            promoCardsIssued
          },
          credits: {
            totalUsersWithCredit: usersWithCredit,
            totalCreditBalance,
            totalCreditSpent: totalSpent
          }
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (type === 'cards') {
      // Get all gift cards
      const cards = await queryCollection('giftCards', {
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 100,
        skipCache: true
      });

      return new Response(JSON.stringify({
        success: true,
        cards
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (type === 'balances') {
      // Get all user credit balances
      const credits = await queryCollection('userCredits', {
        orderBy: { field: 'balance', direction: 'DESCENDING' },
        skipCache: true
      });

      // Get customer info for each
      const balances = await Promise.all(credits.map(async (credit) => {
        let customerInfo = { email: 'Unknown', name: 'Unknown' };

        try {
          const customer = await getDocument('users', credit.id);
          if (customer) {
            customerInfo = {
              email: customer.email || 'Unknown',
              name: customer.displayName || customer.firstName || 'Unknown'
            };
          }
        } catch (e) {}

        return {
          userId: credit.id,
          balance: credit.balance || 0,
          lastUpdated: credit.lastUpdated,
          transactionCount: credit.transactions?.length || 0,
          ...customerInfo
        };
      }));

      return new Response(JSON.stringify({
        success: true,
        balances: balances.filter(b => b.balance > 0 || b.transactionCount > 0)
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Default: return everything
    const [cards, credits] = await Promise.all([
      queryCollection('giftCards', {
        orderBy: { field: 'createdAt', direction: 'DESCENDING' },
        limit: 50,
        skipCache: true
      }),
      queryCollection('userCredits', {
        orderBy: { field: 'balance', direction: 'DESCENDING' },
        limit: 50,
        skipCache: true
      })
    ]);

    return new Response(JSON.stringify({
      success: true,
      cards,
      balances: credits
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[admin/giftcards] GET Error:', error);
    return ApiErrors.serverError('Failed to fetch gift card data');
  }
};

// POST: Create gift card or adjust user balance
export const POST: APIRoute = async ({ request, locals }) => {
  const clientId = getClientId(request);
  const rateCheck = checkRateLimit(`giftcards-write:${clientId}`, RateLimiters.write);
  if (!rateCheck.allowed) return rateLimitResponse(rateCheck.retryAfter!);


  try {
    const data = await request.json();

    // Validate admin auth (timing-safe comparison)
    const { requireAdminAuth, initAdminEnv } = await import('../../../lib/admin');
    const adminEnv = locals?.runtime?.env;
    initAdminEnv({ ADMIN_UIDS: adminEnv?.ADMIN_UIDS, ADMIN_EMAILS: adminEnv?.ADMIN_EMAILS });
    const authError = await requireAdminAuth(request, locals, data);
    if (authError) return authError;

    const parsed = giftcardsPostSchema.safeParse(data);
    if (!parsed.success) {
      return ApiErrors.badRequest('Invalid request');
    }

    const { action } = parsed.data;
    const now = new Date().toISOString();

    if (action === 'createCard') {
      // Create a new gift card
      const { value, type, description, expiresInDays } = data;

      if (!value || value <= 0) {
        return ApiErrors.badRequest('Invalid value');
      }

      // Generate code
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = 'FWGC-';
      for (let i = 0; i < 12; i++) {
        if (i > 0 && i % 4 === 0) code += '-';
        code += chars[Math.floor(Math.random() * chars.length)];
      }

      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;

      const newCard = {
        code,
        originalValue: parseFloat(value),
        currentBalance: parseFloat(value),
        type: type || 'promotional',
        description: description || `£${value} Gift Card`,
        createdAt: now,
        expiresAt,
        isActive: true,
        redeemedBy: null,
        redeemedAt: null,
        createdByAdmin: true
      };

      const result = await addDocument('giftCards', newCard);

      return new Response(JSON.stringify({
        success: true,
        giftCard: { ...newCard, id: result.id }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'adjustBalance') {
      // Adjust a user's credit balance
      const { userId, amount, reason } = data;

      if (!userId || amount === undefined) {
        return ApiErrors.badRequest('User ID and amount required');
      }

      const adjustAmount = parseFloat(amount);
      const creditDoc = await getDocument('userCredits', userId);

      let newBalance: number;
      const transactionId = `txn_admin_${Date.now()}`;

      if (creditDoc) {
        const currentBalance = creditDoc.balance || 0;
        newBalance = Math.max(0, currentBalance + adjustAmount);

        await updateDocument('userCredits', userId, {
          balance: newBalance,
          lastUpdated: now
        });

        // Add transaction using arrayUnion helper
        await arrayUnion('userCredits', userId, 'transactions', [{
          id: transactionId,
          type: 'admin_adjustment',
          amount: adjustAmount,
          description: reason || `Admin adjustment: ${adjustAmount >= 0 ? '+' : ''}£${adjustAmount.toFixed(2)}`,
          createdAt: now,
          balanceAfter: newBalance
        }]);
      } else {
        newBalance = Math.max(0, adjustAmount);
        await setDocument('userCredits', userId, {
          userId,
          balance: newBalance,
          lastUpdated: now,
          transactions: [{
            id: transactionId,
            type: 'admin_adjustment',
            amount: adjustAmount,
            description: reason || `Admin credit: £${adjustAmount.toFixed(2)}`,
            createdAt: now,
            balanceAfter: newBalance
          }]
        });
      }

      // Update customer doc (ignore errors if doesn't exist)
      try {
        await updateDocument('users', userId, {
          creditBalance: newBalance,
          creditUpdatedAt: now
        });
      } catch (e) {}

      return new Response(JSON.stringify({
        success: true,
        newBalance,
        adjustment: adjustAmount
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'deactivateCard') {
      // Deactivate a gift card
      const { cardId } = data;

      if (!cardId) {
        return ApiErrors.badRequest('Card ID required');
      }

      await updateDocument('giftCards', cardId, {
        isActive: false,
        deactivatedAt: now,
        deactivatedByAdmin: true
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Card deactivated'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'reactivateCard') {
      // Reactivate a cancelled gift card (for lost codes recovery)
      const { cardId } = data;

      if (!cardId) {
        return ApiErrors.badRequest('Card ID required');
      }

      // Get the card to check it hasn't been redeemed
      const cardDoc = await getDocument('giftCards', cardId);
      if (!cardDoc) {
        return ApiErrors.notFound('Card not found');
      }

      if (cardDoc.redeemedBy) {
        return ApiErrors.badRequest('Cannot reactivate a redeemed card');
      }

      await updateDocument('giftCards', cardId, {
        isActive: true,
        reactivatedAt: now,
        reactivatedByAdmin: true,
        deactivatedAt: null,
        deactivatedByAdmin: null
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Card reactivated'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (action === 'resendEmail') {
      // Resend gift card email to a different/same recipient
      const { cardId, code, recipientEmail, recipientName } = data;

      if (!cardId || !recipientEmail) {
        return ApiErrors.badRequest('Card ID and recipient email required');
      }

      // Get the card details
      const cardDoc = await getDocument('giftCards', cardId);
      if (!cardDoc) {
        return ApiErrors.notFound('Card not found');
      }

      const amount = cardDoc.originalValue || 0;
      const cardCode = code || cardDoc.code;

      // Send email
      try {
        const giftCardContent = `
              <h2 style="font-size: 28px; color: #111111; text-align: center; margin: 0 0 20px 0;" class="light-text">
                Your Gift Card Code
              </h2>

              <p style="color: #6b7280; text-align: center; margin-bottom: 30px;" class="light-text-secondary">
                ${recipientName ? `Hi ${esc(recipientName)},` : ''} Here's your <span style="color: #111111;" class="light-text">Fresh</span> <span style="color: #dc2626;">Wax</span> gift card code.
              </p>

              <!-- Gift Card Box -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td style="background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%); border-radius: 16px; padding: 30px; text-align: center;">
                    <p style="color: #888; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 10px 0;">Gift Card Value</p>
                    <p style="font-size: 48px; color: #dc2626; font-weight: 700; margin: 0 0 20px 0;">\u00a3${amount}</p>
                    <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0;">Your Redemption Code</p>
                    <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                      <tr>
                        <td style="background: #111; border: 2px solid #dc2626; border-radius: 10px; padding: 15px 25px;">
                          <code style="font-size: 24px; color: #fff; letter-spacing: 3px; font-family: 'Monaco', 'Consolas', monospace;">${esc(cardCode)}</code>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- How to Use -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td style="background: #f9f9f9; border-radius: 12px; padding: 25px;" class="light-detail-box">
                    <h3 style="font-size: 18px; color: #111111; margin: 0 0 15px 0;" class="light-text">How to Redeem</h3>
                    <ol style="color: #6b7280; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;" class="light-text-secondary">
                      <li>Visit <a href="${SITE_URL}/giftcards/" style="color: #dc2626;">freshwax.co.uk/giftcards</a></li>
                      <li>Sign in or create an account</li>
                      <li>Enter your code above</li>
                      <li>Start shopping!</li>
                    </ol>
                  </td>
                </tr>
              </table>

              ${ctaButton('Redeem Your Gift Card', SITE_URL + '/giftcards/')}`;

        const html = emailWrapper(giftCardContent, {
          title: 'Your Gift Card Code',
          hideHeader: true,
          lightTheme: true,
          footerBrand: 'Fresh Wax - Underground Jungle & Drum and Bass',
        });

        await sendEmail(
          recipientEmail,
          `🎁 Your £${amount} Fresh Wax Gift Card Code`,
          html
        );

        // Update card with email record using arrayUnion
        await arrayUnion('giftCards', cardId, 'emailsSent', [{
          email: recipientEmail,
          sentAt: now,
          type: 'admin_resend'
        }]);

        await updateDocument('giftCards', cardId, {
          recipientEmail: recipientEmail,
          recipientName: recipientName || cardDoc.recipientName || null
        });

        return new Response(JSON.stringify({
          success: true,
          message: `Email sent to ${recipientEmail}`
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (emailError) {
        console.error('[admin/giftcards] Email error:', emailError);
        return ApiErrors.serverError('Failed to send email');
      }
    }

    return ApiErrors.badRequest('Invalid action');

  } catch (error: unknown) {
    console.error('[admin/giftcards] POST Error:', error);
    return ApiErrors.serverError('Failed to process request');
  }
};
