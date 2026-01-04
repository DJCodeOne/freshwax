// src/pages/api/admin/giftcards.ts
// Admin API for gift cards management - list, create, analytics

import type { APIRoute } from 'astro';
import { getDocument, updateDocument, setDocument, queryCollection, addDocument, arrayUnion, initFirebaseEnv } from '../../../lib/firebase-rest';

const FROM_EMAIL = 'Fresh Wax <noreply@freshwax.co.uk>';

// Helper to get admin key from environment
function getAdminKey(locals: any): string {
  const env = locals?.runtime?.env;
  return env?.ADMIN_KEY || import.meta.env.ADMIN_KEY || '';
}

// Helper to initialize Firebase
function initFirebase(locals: any) {
  const env = locals?.runtime?.env;
  initFirebaseEnv({
    FIREBASE_PROJECT_ID: env?.FIREBASE_PROJECT_ID || import.meta.env.FIREBASE_PROJECT_ID,
    FIREBASE_API_KEY: env?.FIREBASE_API_KEY || import.meta.env.FIREBASE_API_KEY,
  });
}

// Send email via Resend API (using fetch for Cloudflare compatibility)
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const RESEND_API_KEY = import.meta.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[admin/giftcards] No Resend API key configured');
    return false;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
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
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[admin/giftcards] Resend error:', response.status, error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('[admin/giftcards] Email send error:', error);
    return false;
  }
}

// GET: Fetch gift cards, user balances, and analytics
export const GET: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
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
          const customer = await getDocument('customers', credit.id);
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

  } catch (error) {
    console.error('[admin/giftcards] GET Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to fetch gift card data'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// POST: Create gift card or adjust user balance
export const POST: APIRoute = async ({ request, locals }) => {
  initFirebase(locals);
  try {
    const data = await request.json();
    const { action, adminKey } = data;

    // Validate admin key
    if (adminKey !== getAdminKey(locals)) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized'
      }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    }

    const now = new Date().toISOString();

    if (action === 'createCard') {
      // Create a new gift card
      const { value, type, description, expiresInDays } = data;

      if (!value || value <= 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Invalid value'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'User ID and amount required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
        await updateDocument('customers', userId, {
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Card ID required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Card ID required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Get the card to check it hasn't been redeemed
      const cardDoc = await getDocument('giftCards', cardId);
      if (!cardDoc) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Card not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      if (cardDoc.redeemedBy) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Cannot reactivate a redeemed card'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
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
        return new Response(JSON.stringify({
          success: false,
          error: 'Card ID and recipient email required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      // Get the card details
      const cardDoc = await getDocument('giftCards', cardId);
      if (!cardDoc) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Card not found'
        }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }

      const amount = cardDoc.originalValue || 0;
      const cardCode = code || cardDoc.code;

      // Send email
      try {
        const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.1);">
          <!-- Header -->
          <tr>
            <td style="background: #ffffff; padding: 30px; text-align: center; border-bottom: 3px solid #dc2626;">
              <h1 style="margin: 0; font-size: 32px; color: #000; font-weight: 700;">
                Fresh <span style="color: #dc2626;">Wax</span>
              </h1>
              <p style="margin: 10px 0 0 0; color: #888; font-size: 14px;">Underground Music Store</p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <div style="text-align: center; margin-bottom: 30px;">
                <!-- Gift Box Icon -->
                <table cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto;">
                  <!-- Bow loops -->
                  <tr>
                    <td align="center" style="padding-bottom: 0;">
                      <table cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td style="width: 18px; height: 14px; background: #dc2626; border-radius: 50%;"></td>
                          <td style="width: 8px;"></td>
                          <td style="width: 18px; height: 14px; background: #dc2626; border-radius: 50%;"></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <!-- Bow center -->
                  <tr>
                    <td align="center" style="padding-bottom: 2px;">
                      <div style="width: 12px; height: 12px; background: #b91c1c; border-radius: 50%; margin: 0 auto;"></div>
                    </td>
                  </tr>
                  <!-- Lid with ribbon -->
                  <tr>
                    <td align="center">
                      <table cellpadding="0" cellspacing="0" border="0" style="background: #ef4444; border-radius: 4px;">
                        <tr>
                          <td style="width: 25px; height: 14px;"></td>
                          <td style="width: 14px; height: 14px; background: #fbbf24;"></td>
                          <td style="width: 25px; height: 14px;"></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <!-- Box body with ribbon -->
                  <tr>
                    <td align="center">
                      <table cellpadding="0" cellspacing="0" border="0" style="background: #dc2626; border-radius: 0 0 4px 4px;">
                        <tr>
                          <td style="width: 23px; height: 40px;"></td>
                          <td style="width: 14px; height: 40px; background: #fbbf24;"></td>
                          <td style="width: 23px; height: 40px;"></td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </div>

              <h2 style="font-size: 28px; color: #111; text-align: center; margin: 0 0 20px 0;">
                Your Gift Card Code
              </h2>

              <p style="color: #666; text-align: center; margin-bottom: 30px;">
                ${recipientName ? `Hi ${recipientName},` : ''} Here's your <span style="color: #000;">Fresh</span> <span style="color: #dc2626;">Wax</span> gift card code.
              </p>

              <!-- Gift Card Box -->
              <div style="background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%); border-radius: 16px; padding: 30px; text-align: center; margin: 30px 0;">
                <p style="color: #888; font-size: 14px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 10px 0;">Gift Card Value</p>
                <p style="font-size: 48px; color: #dc2626; font-weight: 700; margin: 0 0 20px 0;">£${amount}</p>

                <p style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px 0;">Your Redemption Code</p>
                <div style="background: #111; border: 2px solid #dc2626; border-radius: 10px; padding: 15px 25px; display: inline-block;">
                  <code style="font-size: 24px; color: #fff; letter-spacing: 3px; font-family: 'Monaco', 'Consolas', monospace;">${cardCode}</code>
                </div>
              </div>

              <!-- How to Use -->
              <div style="background: #f9f9f9; border-radius: 12px; padding: 25px; margin: 30px 0;">
                <h3 style="font-size: 18px; color: #111; margin: 0 0 15px 0;">How to Redeem</h3>
                <ol style="color: #666; font-size: 15px; line-height: 1.8; margin: 0; padding-left: 20px;">
                  <li>Visit <a href="https://freshwax.co.uk/giftcards" style="color: #dc2626;">freshwax.co.uk/giftcards</a></li>
                  <li>Sign in or create an account</li>
                  <li>Enter your code above</li>
                  <li>Start shopping!</li>
                </ol>
              </div>

              <!-- CTA Button -->
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://freshwax.co.uk/giftcards" style="display: inline-block; background: #dc2626; color: #fff; text-decoration: none; padding: 16px 40px; border-radius: 10px; font-size: 16px; font-weight: 600;">
                  Redeem Your Gift Card →
                </a>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #f5f5f5; padding: 25px 30px; text-align: center; border-top: 1px solid #eee;">
              <p style="color: #888; font-size: 13px; margin: 0;">
                <span style="color: #000;">Fresh</span> <span style="color: #dc2626;">Wax</span> - Underground Jungle & Drum and Bass<br>
                <a href="https://freshwax.co.uk" style="color: #dc2626;">freshwax.co.uk</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `;

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
        return new Response(JSON.stringify({
          success: false,
          error: 'Failed to send email'
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid action'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[admin/giftcards] POST Error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to process request'
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};
