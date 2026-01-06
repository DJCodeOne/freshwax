// src/lib/paypal-payouts.ts
// PayPal Payouts API integration

interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  sandbox?: boolean;
}

interface PayoutRecipient {
  email: string;
  amount: number;
  currency?: string;
  note?: string;
  recipientType?: 'EMAIL' | 'PHONE' | 'PAYPAL_ID';
  reference?: string;
}

interface PayoutResult {
  success: boolean;
  batchId?: string;
  payoutItemId?: string;
  status?: string;
  error?: string;
}

// Get PayPal access token
async function getAccessToken(config: PayPalConfig): Promise<string> {
  const baseUrl = config.sandbox
    ? 'https://api-m.sandbox.paypal.com'
    : 'https://api-m.paypal.com';

  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`PayPal auth failed: ${error}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Create a single payout
export async function createPayout(
  config: PayPalConfig,
  recipient: PayoutRecipient
): Promise<PayoutResult> {
  try {
    const accessToken = await getAccessToken(config);
    const baseUrl = config.sandbox
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';

    const batchId = `FW-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const payload = {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: 'You have received a payment from Fresh Wax',
        email_message: recipient.note || 'Thank you for selling on Fresh Wax!',
      },
      items: [
        {
          recipient_type: recipient.recipientType || 'EMAIL',
          amount: {
            value: recipient.amount.toFixed(2),
            currency: recipient.currency || 'GBP',
          },
          receiver: recipient.email,
          note: recipient.note || 'Fresh Wax payout',
          sender_item_id: recipient.reference || batchId,
        },
      ],
    };

    const response = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[PayPal] Payout error:', data);
      return {
        success: false,
        error: data.message || data.details?.[0]?.issue || 'Payout failed',
      };
    }

    return {
      success: true,
      batchId: data.batch_header?.payout_batch_id,
      payoutItemId: data.items?.[0]?.payout_item_id,
      status: data.batch_header?.batch_status,
    };
  } catch (error: any) {
    console.error('[PayPal] Payout error:', error);
    return {
      success: false,
      error: error.message || 'PayPal payout failed',
    };
  }
}

// Create batch payout for multiple recipients
export async function createBatchPayout(
  config: PayPalConfig,
  recipients: PayoutRecipient[],
  batchNote?: string
): Promise<PayoutResult & { items?: any[] }> {
  try {
    const accessToken = await getAccessToken(config);
    const baseUrl = config.sandbox
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';

    const batchId = `FW-BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const payload = {
      sender_batch_header: {
        sender_batch_id: batchId,
        email_subject: 'You have received a payment from Fresh Wax',
        email_message: batchNote || 'Thank you for selling on Fresh Wax!',
      },
      items: recipients.map((r, i) => ({
        recipient_type: r.recipientType || 'EMAIL',
        amount: {
          value: r.amount.toFixed(2),
          currency: r.currency || 'GBP',
        },
        receiver: r.email,
        note: r.note || 'Fresh Wax payout',
        sender_item_id: r.reference || `${batchId}-${i}`,
      })),
    };

    const response = await fetch(`${baseUrl}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[PayPal] Batch payout error:', data);
      return {
        success: false,
        error: data.message || data.details?.[0]?.issue || 'Batch payout failed',
      };
    }

    return {
      success: true,
      batchId: data.batch_header?.payout_batch_id,
      status: data.batch_header?.batch_status,
      items: data.items,
    };
  } catch (error: any) {
    console.error('[PayPal] Batch payout error:', error);
    return {
      success: false,
      error: error.message || 'PayPal batch payout failed',
    };
  }
}

// Get payout status
export async function getPayoutStatus(
  config: PayPalConfig,
  batchId: string
): Promise<{ success: boolean; status?: string; items?: any[]; error?: string }> {
  try {
    const accessToken = await getAccessToken(config);
    const baseUrl = config.sandbox
      ? 'https://api-m.sandbox.paypal.com'
      : 'https://api-m.paypal.com';

    const response = await fetch(`${baseUrl}/v1/payments/payouts/${batchId}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    const data = await response.json();

    return {
      success: true,
      status: data.batch_header?.batch_status,
      items: data.items,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
    };
  }
}

// Verify a PayPal email is valid (optional - sends $0.01 test)
export async function verifyPayPalEmail(
  config: PayPalConfig,
  email: string
): Promise<{ valid: boolean; error?: string }> {
  // PayPal doesn't have a direct email verification API
  // The payout will fail if the email isn't a valid PayPal account
  // For now, we just validate the email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }

  return { valid: true };
}

export function getPayPalConfig(env: any): PayPalConfig | null {
  const clientId = env?.PAYPAL_CLIENT_ID || import.meta.env.PAYPAL_CLIENT_ID;
  const clientSecret = env?.PAYPAL_CLIENT_SECRET || import.meta.env.PAYPAL_CLIENT_SECRET;
  const sandbox = env?.PAYPAL_SANDBOX === 'true' || import.meta.env.PAYPAL_SANDBOX === 'true';

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret, sandbox };
}
